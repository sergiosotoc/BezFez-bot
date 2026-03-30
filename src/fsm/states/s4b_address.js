/* src/fsm/states/s4b_address.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import { parseForm, mergeFormData } from '../../parsers/formParser.js';
import { formatPaymentMessage } from '../../services/calculator.js';
import { createOrder } from '../../services/supabase.js';

const OPTIONAL_FIELDS = [
  'nombre_origen', 'calle_origen', 'colonia_origen', 'ciudad_origen', 'cel_origen',
  'nombre_destino', 'calle_destino', 'colonia_destino', 'ciudad_destino', 'cel_destino',
  'contenido',
];

function getMissingOptionalFields(formData) {
  return OPTIONAL_FIELDS.filter(f => !formData[f]);
}

// Pregunta conversacional cuando solo falta un campo
const SINGLE_FIELD_PROMPT = {
  nombre_origen:   '¿Cuál es el *nombre del remitente*?',
  calle_origen:    '¿Cuál es la *calle y número de origen*?',
  colonia_origen:  '¿Cuál es la *colonia de origen*?',
  ciudad_origen:   '¿Cuál es la *ciudad y estado de origen*?',
  cel_origen:      '¿Cuál es el *celular del remitente*?',
  nombre_destino:  '¿Cuál es el *nombre del destinatario*?',
  calle_destino:   '¿Cuál es la *calle y número de destino*?',
  colonia_destino: '¿Cuál es la *colonia de destino*?',
  ciudad_destino:  '¿Cuál es la *ciudad y estado de destino*?',
  cel_destino:     '¿Cuál es el *celular del destinatario*?',
  contenido:       '¿Qué contiene el paquete? (ej: ropa, electrónicos, peluches)',
};

function buildAddressForm(missingFields) {
  // Un solo campo: pregunta conversacional
  if (missingFields.length === 1) {
    return SINGLE_FIELD_PROMPT[missingFields[0]] ||
      `Por favor indícame: ${missingFields[0].replace(/_/g, ' ')}`;
  }

  // Varios campos: formato a rellenar
  const origenFields = {
    nombre_origen:  'Nombre Origen:',
    calle_origen:   'Calle y Numero Origen:',
    colonia_origen: 'Colonia Origen:',
    ciudad_origen:  'Ciudad y Estado Origen:',
    cel_origen:     'Cel Origen:',
  };
  const destinoFields = {
    nombre_destino:  'Nombre Destino:',
    calle_destino:   'Calle y Numero Destino:',
    colonia_destino: 'Colonia Destino:',
    ciudad_destino:  'Ciudad y Estado Destino:',
    cel_destino:     'Cel Destino:',
  };
  const paqueteFields = {
    contenido: 'Contenido:',
  };

  const missingSet   = new Set(missingFields);
  const origenLines  = Object.entries(origenFields).filter(([k]) => missingSet.has(k));
  const destinoLines = Object.entries(destinoFields).filter(([k]) => missingSet.has(k));
  const paqueteLines = Object.entries(paqueteFields).filter(([k]) => missingSet.has(k));

  const lines = [
    '📦 *PASO 2 – GENERAR TU GUÍA*',
    '',
    '¡Excelente elección! Para crear tu guía necesito algunos datos adicionales.',
    'Por favor copia y rellena el siguiente formato:',
    '',
  ];

  if (origenLines.length > 0) {
    lines.push('*ORIGEN* 📍');
    origenLines.forEach(([, label]) => lines.push(label));
    lines.push('');
  }
  if (destinoLines.length > 0) {
    lines.push('*DESTINO* 📍');
    destinoLines.forEach(([, label]) => lines.push(label));
    lines.push('');
  }
  if (paqueteLines.length > 0) {
    lines.push('*PAQUETE* 📦');
    paqueteLines.forEach(([, label]) => lines.push(label));
    lines.push('');
  }

  return lines.join('\n');
}

export async function handleAwaitingAddress(ctx) {
  const { chatId, text, session, sender } = ctx;

  if (!text) return;

  const { form_data, invoice_required, billable_weight, oversize_charge } = session;

  if (!form_data) {
    await sender.sendText(chatId, 'Hubo un error con tus datos. Escribe *hola* para reiniciar.');
    return;
  }

  // ── 1. Parsear con el parser estructurado y mergear ───────
  const { data: parsed } = parseForm(text);
  let merged = mergeFormData(form_data, parsed);

  // ── 2. Respuesta directa para campo único ─────────────────
  // Si antes del parse faltaba exactamente 1 campo y después sigue
  // faltando el mismo, el mensaje completo del cliente ES ese valor.
  const prevMissing  = getMissingOptionalFields(form_data);
  const afterParsing = getMissingOptionalFields(merged);

  if (
    prevMissing.length === 1 &&
    afterParsing.length === 1 &&
    prevMissing[0] === afterParsing[0]
  ) {
    const field   = prevMissing[0];
    const trimmed = text.trim();

    const isValid = (field === 'cel_origen' || field === 'cel_destino')
      ? /^\+?[\d\s\-()]{7,}$/.test(trimmed)
      : trimmed.length >= 2;

    if (isValid) {
      merged = mergeFormData(merged, { [field]: trimmed });
    }
  }

  const stillMissing = getMissingOptionalFields(merged);

  // ── 3. Faltan campos → guardar progreso y preguntar ───────
  if (stillMissing.length > 0) {
    await updateSession(chatId, { form_data: merged });
    await sender.sendText(chatId, buildAddressForm(stillMissing));
    return;
  }

  // ── 4. Todo completo → crear orden ───────────────────────
  const { selected_carrier, total_amount } = session;

  if (!selected_carrier || !total_amount) {
    await sender.sendText(chatId, 'Hubo un error con tu selección. Escribe *hola* para reiniciar.');
    return;
  }

  const order = await createOrder({
    chat_id: chatId,
    carrier: selected_carrier,
    total_amount,
    invoice_required,
    billable_weight,
    oversize_charge,
    form_snapshot: merged,
    status: 'PENDING_PAYMENT',
  });

  // ── 5. Transición a AWAITING_PAYMENT ─────────────────────
  const { success } = await transitionState(
    chatId,
    'AWAITING_ADDRESS',
    'AWAITING_PAYMENT',
    { form_data: { ...merged, current_folio: order.folio } }
  );

  if (!success) return;

  // ── 6. PASO 3: mensaje de pago ────────────────────────────
  const paymentMsg = formatPaymentMessage(order.folio, total_amount);
  await sender.sendText(chatId, paymentMsg);
}

export function needsAddressCollection(formData) {
  return getMissingOptionalFields(formData).length > 0;
}

export function buildInitialAddressRequest(formData) {
  const missing = getMissingOptionalFields(formData);
  return buildAddressForm(missing);
}
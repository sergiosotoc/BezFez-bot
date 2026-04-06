/* src/fsm/states/s4b_address.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import { parseForm, mergeFormData } from '../../parsers/formParser.js';
import { createOrder } from '../../services/supabase.js';

const REQUIRED_FIELDS = [
  'nombre_origen',
  'calle_origen',
  'colonia_origen',
  'ciudad_origen',
  'cel_origen',
  'nombre_destino',
  'calle_destino',
  'colonia_destino',
  'ciudad_destino',
  'cel_destino',
  'contenido',
];

function getMissingFields(formData) {
  return REQUIRED_FIELDS.filter(f => {
    const val = formData[f];
    if (!val) return true;
    const strVal = String(val).trim();
    if (f.startsWith('cel_')) return strVal.length < 10;
    return strVal.length < 2;
  });
}

function cleanPhone(value) {
  if (!value) return null;
  let cleaned = String(value).replace(/[^0-9]/g, '');
  if (cleaned.startsWith('52') && cleaned.length === 12) cleaned = cleaned.slice(2);
  return cleaned.length === 10 ? cleaned : null;
}

const SINGLE_FIELD_PROMPT = {
  nombre_origen: '👤 ¿Cuál es el *nombre del remitente*?',
  calle_origen: '📍 ¿Cuál es la *calle y número de origen*?',
  colonia_origen: '🏘️ ¿Cuál es la *colonia de origen*?',
  ciudad_origen: '🌆 ¿Cuál es la *ciudad y estado de origen*?',
  cel_origen: '📱 ¿Cuál es el *celular del remitente*? (10 dígitos)',
  nombre_destino: '👤 ¿Cuál es el *nombre del destinatario*?',
  calle_destino: '📍 ¿Cuál es la *calle y número de destino*?',
  colonia_destino: '🏘️ ¿Cuál es la *colonia de destino*?',
  ciudad_destino: '🌆 ¿Cuál es la *ciudad y estado de destino*?',
  cel_destino: '📱 ¿Cuál es el *celular del destinatario*? (10 dígitos)',
  contenido: '📦 ¿Qué contiene el paquete? (ej: ropa, calzado)',
};

function buildAddressForm(missingFields) {
  // Si faltan pocos campos, aún se pide uno por uno
  if (missingFields.length <= 3) {
    return SINGLE_FIELD_PROMPT[missingFields[0]];
  }

  // Si faltan varios, mostrar el formulario completo
  const lines = [
    '📦 *PASO 2 – GENERAR TU GUÍA*',
    '',
    'Necesito estos datos para completar tu guía. Puedes enviarlos uno por uno o rellenar este formato:',
    '',
    '*ORIGEN*',
    'Nombre Origen:',
    'Calle y Número Origen:',
    'Colonia Origen:',
    'Ciudad y Estado Origen:',
    'Cel Origen:',
    '',
    '*DESTINO*',
    'Nombre Destino:',
    'Calle y Número Destino:',
    'Colonia Destino:',
    'Ciudad y Estado Destino:',
    'Cel Destino:',
    '',
    '*PAQUETE*',
    'Contenido:',
  ];

  return lines.join('\n');
}

export async function handleAwaitingAddress(ctx) {
  const { chatId, text, session, sender } = ctx;
  if (!text) return;

  const { form_data, selected_carrier, total_amount, invoice_required, billable_weight, oversize_charge } = session;

  let merged = { ...form_data };

  const lineCount = text.split('\n').filter(l => l.trim()).length;
  if (text.length > 30 || lineCount >= 3) {
    const { data: parsedFull } = parseForm(text);
    // También intentar parseFormatoLibre directamente para formatos alternativos
    if (Object.keys(parsedFull).filter(k => parsedFull[k]).length < 3) {
      const { parseFormatoLibre } = await import('../../parsers/formParser.js');
      const libreData = parseFormatoLibre(text);
      merged = mergeFormData(merged, libreData);
    } else {
      merged = mergeFormData(merged, parsedFull);
    }
  } else {
    const missingBefore = getMissingFields(merged);
    const fieldToFill = missingBefore[0];
    const value = text.trim();

    if (fieldToFill === 'cel_origen' || fieldToFill === 'cel_destino') {
      const cleaned = cleanPhone(value);
      if (cleaned) {
        merged[fieldToFill] = cleaned;
      } else {
        await sender.sendText(chatId, `⚠️ Teléfono inválido. Debe tener 10 dígitos.\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    } else {
      if (value.length >= 2) merged[fieldToFill] = value;
    }
  }

  const missingAfter = getMissingFields(merged);

  await updateSession(chatId, { form_data: merged });

  if (missingAfter.length > 0) {
    await sender.sendText(chatId, buildAddressForm(missingAfter));
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

  const { success } = await transitionState(
    chatId,
    'AWAITING_ADDRESS',
    'AWAITING_PAYMENT',
    {
      form_data: {
        ...merged,
        current_folio: order.folio
      }
    }
  );

  if (success) {
    const { formatPaymentMessage } = await import('../../services/calculator.js');
    await sender.sendText(chatId, formatPaymentMessage(order.folio, total_amount, merged));
  }
}

export function needsAddressCollection(formData) {
  return getMissingFields(formData).length > 0;
}

export function buildInitialAddressRequest(formData) {
  return buildAddressForm(getMissingFields(formData));
}

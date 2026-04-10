/* src/fsm/states/s4b_address.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import { mergeFormData, normalizePhone } from '../../parsers/formParser.js';
import { formatAdminSummary } from '../../services/calculator.js';
import { startPause } from '../../services/deadman.js';
import { config } from '../../config/index.js';

const REQUIRED_FIELDS = [
  'nombre_origen',
  'calle_origen',
  'colonia_origen',
  'ciudad_origen',
  'cp_origen',
  'cel_origen',
  'nombre_destino',
  'calle_destino',
  'colonia_destino',
  'ciudad_destino',
  'cp_destino',
  'cel_destino',
  'medidas',
  'peso',
  'contenido',
];

function getMissingFields(formData) {
  const missing = [];

  for (const f of REQUIRED_FIELDS) {
    const val = formData[f];

    // Verificar si el campo existe y no está vacío
    if (!val || String(val).trim() === '') {
      missing.push(f);
      continue;
    }

    const strVal = String(val).trim();

    // Validaciones específicas
    if (f.startsWith('cel_')) {
      if (!/^\d{10}$/.test(strVal)) {
        missing.push(f);
      }
    }
    else if (f === 'cp_origen' || f === 'cp_destino') {
      if (!/^\d{5}$/.test(strVal)) {
        missing.push(f);
      }
    }
    else if (f === 'medidas') {
      if (!/^\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?$/.test(strVal)) {
        missing.push(f);
      }
    }
    else if (f === 'peso') {
      const pesoNum = parseFloat(strVal);
      if (isNaN(pesoNum) || pesoNum <= 0 || pesoNum > 1000) {
        missing.push(f);
      }
    }
    else if (f === 'contenido') {
      // Validación estricta para contenido
      const hasLetters = /[a-zA-Z]/.test(strVal);
      const isTooShort = strVal.length < 3;
      const isGeneric = /^(destinatario|remitente|paquete|producto|articulo)$/i.test(strVal);

      if (isTooShort || !hasLetters || isGeneric) {
        missing.push(f);
      }
    }
    else {
      // Para campos de texto normales
      if (strVal.length < 2) {
        missing.push(f);
      }
    }
  }

  return missing;
}

const SINGLE_FIELD_PROMPT = {
  nombre_origen: '👤 ¿Cuál es el *nombre del remitente*?',
  calle_origen: '📍 ¿Cuál es la *calle y número de origen*?',
  colonia_origen: '🏘️ ¿Cuál es la *colonia de origen*?',
  ciudad_origen: '🌆 ¿Cuál es la *ciudad y estado de origen*?',
  cp_origen: '📮 ¿Cuál es el *CP de origen*? (5 dígitos)',
  cel_origen: '📱 ¿Cuál es el *celular del remitente*? (10 dígitos, ej: 5512345678)',
  nombre_destino: '👤 ¿Cuál es el *nombre del destinatario*?',
  calle_destino: '📍 ¿Cuál es la *calle y número de destino*?',
  colonia_destino: '🏘️ ¿Cuál es la *colonia de destino*?',
  ciudad_destino: '🌆 ¿Cuál es la *ciudad y estado de destino*?',
  cp_destino: '📮 ¿Cuál es el *CP de destino*? (5 dígitos)',
  cel_destino: '📱 ¿Cuál es el *celular del destinatario*? (10 dígitos, ej: 5512345678)',
  medidas: '📦 ¿Cuáles son las *medidas del paquete*? (ej: 35x35x35)',
  peso: '⚖️ ¿Cuál es el *peso del paquete*? (ej: 5 kg)',
  contenido: '📦 ¿Qué *contenido* tiene el paquete? (ej: ropa, electrónicos, documentos, etc.)',
};

async function assignRequestedFieldValue({ chatId, sender, fieldToFill, value, merged }) {
  if (!fieldToFill) return false;

  if (fieldToFill === 'contenido') {
    const contenidoLower = value.toLowerCase();
    const palabrasProhibidas = ['destinatario', 'remitente', 'paquete', 'producto'];

    if (palabrasProhibidas.includes(contenidoLower) || value.length < 3) {
      await sender.sendText(chatId, `âš ï¸ Por favor, especifica un *contenido vÃ¡lido* para el paquete (ej: ropa, libros, electrÃ³nicos, documentos, etc.)\n\n${SINGLE_FIELD_PROMPT.contenido}`);
      return false;
    }

    merged[fieldToFill] = value;
    return true;
  }

  if (fieldToFill === 'cel_origen' || fieldToFill === 'cel_destino') {
    const cleaned = normalizePhone(value);
    if (!cleaned) {
      await sender.sendText(chatId, `âš ï¸ TelÃ©fono invÃ¡lido. Debe tener 10 dÃ­gitos (ej: 5512345678 o 55 1234 5678)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
      return false;
    }

    merged[fieldToFill] = cleaned;
    return true;
  }

  if (fieldToFill === 'cp_origen' || fieldToFill === 'cp_destino') {
    const cp = value.replace(/\D/g, '');
    if (cp.length !== 5) {
      await sender.sendText(chatId, `âš ï¸ CP invÃ¡lido. Debe ser 5 dÃ­gitos (ej: 44620)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
      return false;
    }

    merged[fieldToFill] = cp;
    return true;
  }

  if (value.length < 2) {
    await sender.sendText(chatId, `âš ï¸ El campo debe tener al menos 2 caracteres.\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
    return false;
  }

  merged[fieldToFill] = value;
  return true;
}

function buildAddressForm(missingFields) {
  // Si solo falta el contenido, preguntar directamente
  if (missingFields.length === 1 && missingFields[0] === 'contenido') {
    return SINGLE_FIELD_PROMPT.contenido;
  }

  // Si faltan pocos campos, se pide uno por uno
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

  const { form_data } = session;

  // Asegurar que form_data tenga las medidas y peso iniciales
  if (!form_data.medidas && session.form_data?.medidas) {
    form_data.medidas = session.form_data.medidas;
    form_data.largo = session.form_data.largo;
    form_data.ancho = session.form_data.ancho;
    form_data.alto = session.form_data.alto;
    form_data.peso = session.form_data.peso;
  }

  let merged = { ...form_data };
  const missingBefore = getMissingFields(merged);
  const fieldToFill = missingBefore[0];
  const value = text.trim();

  const lineCount = text.split('\n').filter(l => l.trim()).length;
  const hasFormatoLibre = text.length > 30 || lineCount >= 3;

  if (hasFormatoLibre) {
    const { parseFormatoLibre } = await import('../../parsers/formParser.js');
    const libreData = parseFormatoLibre(text);

    // Limpiar datos de contenido incorrectos
    if (libreData.contenido) {
      const contenidoLower = libreData.contenido.toLowerCase().trim();
      const palabrasProhibidas = ['destinatario', 'remitente', 'paquete', 'producto'];

      if (palabrasProhibidas.includes(contenidoLower) || contenidoLower.length < 3) {
        delete libreData.contenido;
      }
    }

    // evitar sobrescribir datos buenos con basura
    Object.keys(libreData).forEach(key => {
      if (merged[key]) {
        if (key.startsWith('cel_') && /^\d{10}$/.test(merged[key])) {
          delete libreData[key];
        }
      }
    });

    merged = mergeFormData(merged, libreData);

    if (fieldToFill && !merged[fieldToFill]) {
      const assigned = await assignRequestedFieldValue({ chatId, sender, fieldToFill, value, merged });
      if (!assigned) return;
    }
  } else {
    const assigned = await assignRequestedFieldValue({ chatId, sender, fieldToFill, value, merged });
    if (!assigned) return;
    const missingBeforeLegacy = getMissingFields(merged);
    const fieldToFillLegacy = missingBeforeLegacy[0];
    const valueLegacy = text.trim();

    if (fieldToFillLegacy === 'contenido') {
      // Validación especial para contenido
      const contenidoLower = valueLegacy.toLowerCase();
      const palabrasProhibidas = ['destinatario', 'remitente', 'paquete', 'producto'];

      if (palabrasProhibidas.includes(contenidoLower) || valueLegacy.length < 3) {
        await sender.sendText(chatId, `⚠️ Por favor, especifica un *contenido válido* para el paquete (ej: ropa, libros, electrónicos, documentos, etc.)\n\n${SINGLE_FIELD_PROMPT.contenido}`);
        return;
      }
      merged[fieldToFillLegacy] = valueLegacy;
    }
    else if (fieldToFillLegacy === 'cel_origen' || fieldToFillLegacy === 'cel_destino') {
      const cleaned = normalizePhone(valueLegacy);
      if (cleaned) {
        merged[fieldToFillLegacy] = cleaned;
      } else {
        await sender.sendText(chatId, `⚠️ Teléfono inválido. Debe tener 10 dígitos (ej: 5512345678 o 55 1234 5678)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    }
    else if (fieldToFillLegacy === 'cp_origen' || fieldToFillLegacy === 'cp_destino') {
      const cp = valueLegacy.replace(/\D/g, '');
      if (cp.length === 5) {
        merged[fieldToFillLegacy] = cp;
      } else {
        await sender.sendText(chatId, `⚠️ CP inválido. Debe ser 5 dígitos (ej: 44620)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    }
    else {
      if (valueLegacy.length >= 2) {
        merged[fieldToFillLegacy] = valueLegacy;
      } else {
        await sender.sendText(chatId, `⚠️ El campo debe tener al menos 2 caracteres.\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    }
  }

  const missingAfter = getMissingFields(merged);

  await updateSession(chatId, { form_data: merged });

  if (missingAfter.length > 0) {
    await sender.sendText(chatId, buildAddressForm(missingAfter));
    return;
  }

  const { selected_carrier, total_amount, invoice_required, billable_weight, oversize_charge } = session;

  if (selected_carrier) {
    const folio = `PED-${Date.now()}`;
    const adminSummary = formatAdminSummary({
      folio,
      carrier: selected_carrier,
      total: total_amount,
      clientJid: chatId,
      clientPhone: ctx.clientPhone,
      pushName: ctx.pushName,
      formData: merged,
      calc: { pesoFacturable: billable_weight, oversize: (oversize_charge || 0) > 0 },
      invoice: invoice_required,
    });

    await sender.sendText(config.admin.jid, adminSummary);

    await sender.sendText(
      chatId,
      `✅ *Tu solicitud fue enviada correctamente*\n\nTu guía será generada por un asesor.\n\n📲 En breve recibirás atención personalizada.\nSi hay algún ajuste en el precio, se te notificará antes de generar la guía.`
    );

    await transitionState(chatId, 'AWAITING_ADDRESS', 'PAUSED', { form_data: merged });
    await startPause(chatId, folio, ctx.pushName || chatId);
    return;
  }

  await transitionState(
    chatId, 
    'AWAITING_ADDRESS', 
    'AWAITING_SELECTION', 
    { form_data: merged });
  await sender.sendText(
    chatId, 
    'Perfecto 👍 Ya tengo todos los datos.\n\nAhora confirma tu paquetería escribiendo el número o nombre de la opción que elegiste.');
}

export function needsAddressCollection(formData) {
  return getMissingFields(formData).length > 0;
}

export function buildInitialAddressRequest(formData) {
  return buildAddressForm(getMissingFields(formData));
}

/* src/fsm/states/s4b_address.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import { parseForm, mergeFormData } from '../../parsers/formParser.js';

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

  const { form_data, selected_carrier, total_amount, invoice_required, billable_weight, oversize_charge } = session;

  // Asegurar que form_data tenga las medidas y peso iniciales
  if (!form_data.medidas && session.form_data?.medidas) {
    form_data.medidas = session.form_data.medidas;
    form_data.largo = session.form_data.largo;
    form_data.ancho = session.form_data.ancho;
    form_data.alto = session.form_data.alto;
    form_data.peso = session.form_data.peso;
  }

  let merged = { ...form_data };

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
  } else {
    const missingBefore = getMissingFields(merged);
    const fieldToFill = missingBefore[0];
    const value = text.trim();

    if (fieldToFill === 'contenido') {
      // Validación especial para contenido
      const contenidoLower = value.toLowerCase();
      const palabrasProhibidas = ['destinatario', 'remitente', 'paquete', 'producto'];

      if (palabrasProhibidas.includes(contenidoLower) || value.length < 3) {
        await sender.sendText(chatId, `⚠️ Por favor, especifica un *contenido válido* para el paquete (ej: ropa, libros, electrónicos, documentos, etc.)\n\n${SINGLE_FIELD_PROMPT.contenido}`);
        return;
      }
      merged[fieldToFill] = value;
    }
    else if (fieldToFill === 'cel_origen' || fieldToFill === 'cel_destino') {
      const cleaned = cleanPhone(value);
      if (cleaned) {
        merged[fieldToFill] = cleaned;
      } else {
        await sender.sendText(chatId, `⚠️ Teléfono inválido. Debe tener 10 dígitos (ej: 5512345678 o 55 1234 5678)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    }
    else if (fieldToFill === 'cp_origen' || fieldToFill === 'cp_destino') {
      const cp = value.replace(/\D/g, '');
      if (cp.length === 5) {
        merged[fieldToFill] = cp;
      } else {
        await sender.sendText(chatId, `⚠️ CP inválido. Debe ser 5 dígitos (ej: 44620)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    }
    else {
      if (value.length >= 2) {
        merged[fieldToFill] = value;
      } else {
        await sender.sendText(chatId, `⚠️ El campo debe tener al menos 2 caracteres.\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
        return;
      }
    }
  }

  const missingAfter = getMissingFields(merged);

  // Guardar progreso
  await updateSession(chatId, { form_data: merged });

  if (missingAfter.length > 0) {
    await sender.sendText(chatId, buildAddressForm(missingAfter));
    return;
  }

  await transitionState(
    chatId,
    'AWAITING_ADDRESS',
    'AWAITING_SELECTION',
    {
      form_data: merged
    }
  );

  await sender.sendText(
    chatId,
    'Perfecto 👍 Ya tengo todos los datos.\n\nAhora confirma tu paquetería escribiendo el número o nombre de la opción que elegiste.'
  );
}

export function needsAddressCollection(formData) {
  return getMissingFields(formData).length > 0;
}

export function buildInitialAddressRequest(formData) {
  return buildAddressForm(getMissingFields(formData));
}
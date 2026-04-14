/* src/fsm/states/s4b_address.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import { mergeFormData, normalizePhone } from '../../parsers/formParser.js';
import { getLocationData } from '../../services/geocode.js';
import { formatAdminSummary } from '../../services/calculator.js';
import { startPause } from '../../services/deadman.js';
import { config } from '../../config/index.js';

// 🔥 A. CACHE GLOBAL
const geoCache = new Map();

function isSuspiciousCity(value) {
  if (!value) return true;

  const v = value.toLowerCase().trim();

  return (
    v.length < 4 ||
    !v.includes(',') ||
    ['centro', 'ejidal', 'industrial', 'zona', 'colonia'].includes(v)
  );
}

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

async function fixLocationConsistency(merged) {

  // 🔵 DESTINO
  if (merged.colonia_destino && isSuspiciousCity(merged.ciudad_destino)) {

    const query = [
      merged.colonia_destino,
      merged.cp_destino,
      merged.calle_destino
    ].filter(Boolean).join(', ');

    const loc = await resolveLocationSmart(query);

    if (loc?.ciudad && loc?.estado) {
      merged.ciudad_destino = `${loc.ciudad}, ${loc.estado}`;
    }
  }

  // 🟢 ORIGEN
  if (merged.colonia_origen && isSuspiciousCity(merged.ciudad_origen)) {

    const query = [
      merged.colonia_origen,
      merged.cp_origen,
      merged.calle_origen
    ].filter(Boolean).join(', ');

    const loc = await resolveLocationSmart(query);

    if (loc?.ciudad && loc?.estado) {
      merged.ciudad_origen = `${loc.ciudad}, ${loc.estado}`;
    }
  }

  return merged;
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

// 🔥 B. FUNCIÓN INTELIGENTE DE GEOLOCALIZACIÓN
async function resolveLocationSmart(query) {
  if (!query) return null;

  const key = query.toLowerCase().trim();

  if (geoCache.has(key)) {
    return geoCache.get(key);
  }

  const result = await getLocationData(query);

  if (result) {
    geoCache.set(key, result);
  }

  return result;
}

async function assignRequestedFieldValue({ chatId, sender, fieldToFill, value, merged }) {
  if (!fieldToFill) return false;

  if (fieldToFill === 'contenido') {
    const contenidoLower = value.toLowerCase();
    const palabrasProhibidas = ['destinatario', 'remitente', 'paquete', 'producto'];

    if (palabrasProhibidas.includes(contenidoLower) || value.length < 3) {
      await sender.sendText(chatId, `⚠️ Por favor, especifica un *contenido válido* para el paquete (ej: ropa, libros, electrónicos, documentos, etc.)\n\n${SINGLE_FIELD_PROMPT.contenido}`);
      return false;
    }

    merged[fieldToFill] = value;
    return true;
  }

  if (fieldToFill === 'cel_origen' || fieldToFill === 'cel_destino') {
    const cleaned = normalizePhone(value);
    if (!cleaned) {
      await sender.sendText(chatId, `⚠️ Teléfono inválido. Debe tener 10 dígitos (ej: 5512345678 o 55 1234 5678)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
      return false;
    }

    merged[fieldToFill] = cleaned;
    return true;
  }

  if (fieldToFill === 'cp_origen' || fieldToFill === 'cp_destino') {
    const cp = value.replace(/\D/g, '');
    if (cp.length !== 5) {
      await sender.sendText(chatId, `⚠️ CP inválido. Debe ser 5 dígitos (ej: 44620)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
      return false;
    }

    merged[fieldToFill] = cp;
    return true;
  }

  if (value.length < 2) {
    await sender.sendText(chatId, `⚠️ El campo debe tener al menos 2 caracteres.\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`);
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

  let { form_data } = session;

  // 🔥 CONFIRMACIÓN GEO
  const { pending_location } = session;

  if (pending_location) {
    const answer = text.trim();

    if (answer === '1' || /si|sí/i.test(answer)) {
      const field = pending_location.type === 'destino'
        ? 'ciudad_destino'
        : 'ciudad_origen';

      const updated = {
        ...form_data,
        [field]: pending_location.value
      };

      await updateSession(chatId, {
        form_data: updated,
        pending_location: null
      });

      await sender.sendText(chatId, 'Perfecto 👍');

      return handleAwaitingAddress({
        ...ctx,
        session: { ...session, form_data: updated, pending_location: null }
      });
    }

    if (answer === '2') {
      await updateSession(chatId, { pending_location: null });

      await sender.sendText(chatId,
        'Por favor escribe la ciudad y estado manualmente (ej: Guadalajara, Jal)'
      );
      return;
    }

    return;
  }

  // mantener medidas/peso
  if (!form_data.medidas && session.form_data?.medidas) {
    form_data.medidas = session.form_data.medidas;
    form_data.largo = session.form_data.largo;
    form_data.ancho = session.form_data.ancho;
    form_data.alto = session.form_data.alto;
    form_data.peso = session.form_data.peso;
  }

  let merged = { ...form_data };
  const missingBefore = getMissingFields(merged);
  const value = text.trim();

  const lineCount = text.split('\n').filter(l => l.trim()).length;
  const hasFormatoLibre = text.length > 30 || lineCount >= 3;

  if (hasFormatoLibre) {
    const { parseFormatoLibre } = await import('../../parsers/formParser.js');
    const libreData = parseFormatoLibre(text);

    // limpiar contenido basura
    if (libreData.contenido) {
      const contenidoLower = libreData.contenido.toLowerCase().trim();
      const palabrasProhibidas = ['destinatario', 'remitente', 'paquete', 'producto'];

      if (palabrasProhibidas.includes(contenidoLower) || contenidoLower.length < 3) {
        delete libreData.contenido;
      }
    }

    // 🔥 GEO DESTINO (ANTES DEL MERGE)
    if (!merged.ciudad_destino && libreData.colonia_destino) {
      const query = [
        libreData.colonia_destino,
        libreData.cp_destino,
        libreData.calle_destino
      ].filter(Boolean).join(', ');

      const loc = await resolveLocationSmart(query);

      if (loc?.ciudad && loc?.estado) {
        await updateSession(chatId, {
          pending_location: {
            type: 'destino',
            value: `${loc.ciudad}, ${loc.estado}`
          }
        });

        await sender.sendText(chatId,
          `Detecté para DESTINO:

📍 ${loc.ciudad}, ${loc.estado}

¿Es correcto?
1️⃣ Sí
2️⃣ No`
        );

        return;
      }
    }

    // 🔥 GEO ORIGEN (ANTES DEL MERGE)
    if (!merged.ciudad_origen && libreData.colonia_origen) {
      const query = [
        libreData.colonia_origen,
        libreData.cp_origen,
        libreData.calle_origen
      ].filter(Boolean).join(', ');

      const loc = await resolveLocationSmart(query);

      if (loc?.ciudad && loc?.estado) {
        await updateSession(chatId, {
          pending_location: {
            type: 'origen',
            value: `${loc.ciudad}, ${loc.estado}`
          }
        });

        await sender.sendText(chatId,
          `Detecté para ORIGEN:

📍 ${loc.ciudad}, ${loc.estado}

¿Es correcto?
1️⃣ Sí
2️⃣ No`
        );

        return;
      }
    }

    // 🔥 MERGE PROTEGIDO
    Object.keys(libreData).forEach(key => {
      if (merged[key]) return;

      if (key.includes('ciudad') && libreData[key]?.length < 4) return;
      if (key.includes('colonia') && libreData[key]?.length < 3) return;

      merged[key] = libreData[key];
    });

    // 🔥 PROTECCIÓN CRUZADA
    if (merged.ciudad_origen && merged.colonia_origen === merged.ciudad_origen) {
      delete merged.colonia_origen;
    }

    if (merged.ciudad_destino && merged.colonia_destino === merged.ciudad_destino) {
      delete merged.colonia_destino;
    }

    // 🔥 VALIDACIÓN FINAL DESTINO
    if (merged.cp_destino && merged.colonia_destino && !merged.ciudad_destino) {
      const loc = await resolveLocationSmart(merged.colonia_destino);

      if (loc?.ciudad && loc?.estado) {
        merged.ciudad_destino = `${loc.ciudad}, ${loc.estado}`;
      }
    }

  } else {
    const fieldToFill = missingBefore[0];

    // 🔥 asignación controlada
    if (fieldToFill?.includes('origen')) {
      merged[fieldToFill] = value;
    }
    else if (fieldToFill?.includes('destino')) {
      merged[fieldToFill] = value;
    }
  }

  merged = await fixLocationConsistency(merged);

  // 🔥 CONFIRMACIÓN SI LA CIUDAD SE CORRIGIÓ AUTOMÁTICAMENTE
  if (merged.colonia_destino && isSuspiciousCity(merged.ciudad_destino)) {

    const query = [
      merged.colonia_destino,
      merged.cp_destino
    ].filter(Boolean).join(', ');

    const loc = await resolveLocationSmart(query);

    if (loc?.ciudad && loc?.estado) {

      await updateSession(chatId, {
        pending_location: {
          type: 'destino',
          value: `${loc.ciudad}, ${loc.estado}`
        }
      });

      await sender.sendText(chatId,
        `Detecté para DESTINO:

📍 ${loc.ciudad}, ${loc.estado}

¿Es correcto?
1️⃣ Sí
2️⃣ No`
      );

      return;
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
      calc: {
        pesoFacturable: billable_weight,
        oversize: (oversize_charge || 0) > 0
      },
      invoice: invoice_required,
    });

    await sender.sendText(config.admin.jid, adminSummary);

    await sender.sendText(chatId,
      `✅ *Tu solicitud fue enviada correctamente*

Tu guía será generada por un asesor.

📲 En breve recibirás atención personalizada.`
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
    'Perfecto 👍 Ya tengo todos los datos.\n\nAhora confirma tu paquetería escribiendo el número o nombre de la opción que elegiste.'
  );
}

export function needsAddressCollection(formData) {
  return getMissingFields(formData).length > 0;
}

export function buildInitialAddressRequest(formData) {
  return buildAddressForm(getMissingFields(formData));
}
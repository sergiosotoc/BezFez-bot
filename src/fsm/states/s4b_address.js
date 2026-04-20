/* src/fsm/states/s4b_address.js */

import { transitionState, updateSession } from '../../services/supabase.js';
import { normalizePhone, parseFormatoLibre } from '../../parsers/formParser.js';
import { getLocationData } from '../../services/geocode.js';
import { formatAdminSummary } from '../../services/calculator.js';
import { startPause } from '../../services/deadman.js';
import { config } from '../../config/index.js';
import { logger } from '../../config/logger.js';

// ─────────────────────────────────────────────────────────────────────────────
// CACHE DE GEOCODIFICACIÓN (evita consultas repetidas por sesión)
// ─────────────────────────────────────────────────────────────────────────────

const geoCache = new Map();

async function resolveLocationSmart(colonia, cp = null) {
  const hasCp = cp && /^\d{5}$/.test(String(cp).trim());
  if (!colonia && !hasCp) return null;

  const query = colonia || String(cp).trim();
  const key = `${query}|${cp || ''}`.toLowerCase().trim();

  if (geoCache.has(key)) return geoCache.get(key);

  const result = await getLocationData(query, cp);
  if (result) geoCache.set(key, result);

  return result;
}

async function resolveAddressLocation(colonia, cp = null) {
  const loc = await resolveLocationSmart(colonia, cp);
  if (loc?.ciudad && loc?.estado) return loc;

  if (cp && /^\d{5}$/.test(String(cp).trim())) {
    return resolveLocationSmart(null, cp);
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMPOS REQUERIDOS
// ─────────────────────────────────────────────────────────────────────────────

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

    if (!val || String(val).trim() === '') {
      missing.push(f);
      continue;
    }

    const strVal = String(val).trim();

    if (f.startsWith('cel_')) {
      if (!/^\d{10}$/.test(strVal)) missing.push(f);
    } else if (f === 'cp_origen' || f === 'cp_destino') {
      if (!/^\d{5}$/.test(strVal)) missing.push(f);
    } else if (f === 'medidas') {
      if (!/^\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?\s*[x×]\s*\d+(?:\.\d+)?$/.test(strVal)) missing.push(f);
    } else if (f === 'peso') {
      const pesoNum = parseFloat(strVal);
      if (isNaN(pesoNum) || pesoNum <= 0 || pesoNum > 1000) missing.push(f);
    } else if (f === 'contenido') {
      const hasLetters = /[a-zA-Z]/.test(strVal);
      const isTooShort = strVal.length < 3;
      const isGeneric = /^(destinatario|remitente|paquete|producto|articulo)$/i.test(strVal);
      if (isTooShort || !hasLetters || isGeneric) missing.push(f);
    } else {
      if (strVal.length < 2) missing.push(f);
    }
  }

  return missing;
}

function isSuspiciousCity(value) {
  if (!value) return true;
  const v = value.toLowerCase().trim();
  return (
    v.length < 4 ||
    !v.includes(',') ||
    /col|colonia|ejidal|fracc|residencial|barrio/i.test(v)
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PROMPTS CAMPO POR CAMPO
// ─────────────────────────────────────────────────────────────────────────────

const SINGLE_FIELD_PROMPT = {
  nombre_origen: '👤 ¿Cuál es el *nombre del remitente*?',
  calle_origen: '📍 ¿Cuál es la *calle y número de origen*?',
  colonia_origen: '🏘️ ¿Cuál es la *colonia de origen*?',
  ciudad_origen: '🌆 ¿Cuál es la *ciudad y estado de origen*? (ej: Guadalajara, Jalisco)',
  cp_origen: '📮 ¿Cuál es el *CP de origen*? (5 dígitos)',
  cel_origen: '📱 ¿Cuál es el *celular del remitente*? (10 dígitos, ej: 5512345678)',
  nombre_destino: '👤 ¿Cuál es el *nombre del destinatario*?',
  calle_destino: '📍 ¿Cuál es la *calle y número de destino*?',
  colonia_destino: '🏘️ ¿Cuál es la *colonia de destino*?',
  ciudad_destino: '🌆 ¿Cuál es la *ciudad y estado de destino*? (ej: Monterrey, Nuevo León)',
  cp_destino: '📮 ¿Cuál es el *CP de destino*? (5 dígitos)',
  cel_destino: '📱 ¿Cuál es el *celular del destinatario*? (10 dígitos, ej: 5512345678)',
  medidas: '📦 ¿Cuáles son las *medidas del paquete*? (ej: 35x35x35)',
  peso: '⚖️ ¿Cuál es el *peso del paquete*? (ej: 5 kg)',
  contenido: '📦 ¿Qué *contenido* tiene el paquete? (ej: ropa, electrónicos, documentos)',
};

function buildAddressForm(missingFields) {
  if (missingFields.length === 1) {
    return SINGLE_FIELD_PROMPT[missingFields[0]] || `Falta: ${missingFields[0].replace(/_/g, ' ')}`;
  }

  if (missingFields.length <= 3) {
    return SINGLE_FIELD_PROMPT[missingFields[0]];
  }

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

// ─────────────────────────────────────────────────────────────────────────────
// VALIDACIÓN Y ASIGNACIÓN DE CAMPO
// ─────────────────────────────────────────────────────────────────────────────

export async function assignRequestedFieldValue({ chatId, sender, fieldToFill, value, merged }) {
  if (!fieldToFill) return false;

  if (fieldToFill === 'contenido') {
    const lower = value.toLowerCase();
    const prohibidas = ['destinatario', 'remitente', 'paquete', 'producto'];
    if (prohibidas.includes(lower) || value.length < 3) {
      await sender.sendText(chatId,
        `⚠️ Por favor, especifica un *contenido válido* (ej: ropa, libros, electrónicos)\n\n${SINGLE_FIELD_PROMPT.contenido}`
      );
      return false;
    }
    merged[fieldToFill] = value.trim();
    return true;
  }

  if (fieldToFill === 'cel_origen' || fieldToFill === 'cel_destino') {
    const cleaned = normalizePhone(value);
    if (!cleaned) {
      await sender.sendText(chatId,
        `⚠️ Teléfono inválido. Debe tener 10 dígitos (ej: 5512345678)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`
      );
      return false;
    }
    merged[fieldToFill] = cleaned;
    return true;
  }

  if (fieldToFill === 'cp_origen' || fieldToFill === 'cp_destino') {
    const cp = value.replace(/\D/g, '');
    if (cp.length !== 5) {
      await sender.sendText(chatId,
        `⚠️ CP inválido. Debe ser exactamente 5 dígitos (ej: 44620)\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`
      );
      return false;
    }
    merged[fieldToFill] = cp;
    return true;
  }

  if (value.length < 2) {
    await sender.sendText(chatId,
      `⚠️ El campo debe tener al menos 2 caracteres.\n\n${SINGLE_FIELD_PROMPT[fieldToFill]}`
    );
    return false;
  }

  merged[fieldToFill] = value;
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// REPARACIÓN DE CIUDADES SOSPECHOSAS CON OPENCAGE
// ─────────────────────────────────────────────────────────────────────────────

async function fixLocationConsistency(merged) {
  // DESTINO
  if ((merged.colonia_destino || merged.cp_destino) && isSuspiciousCity(merged.ciudad_destino)) {
    const loc = await resolveAddressLocation(merged.colonia_destino, merged.cp_destino);
    if (loc?.ciudad && loc?.estado) {
      merged.ciudad_destino = `${loc.ciudad}, ${loc.estado}`;
    }
  }

  // ORIGEN
  if ((merged.colonia_origen || merged.cp_origen) && isSuspiciousCity(merged.ciudad_origen)) {
    const loc = await resolveAddressLocation(merged.colonia_origen, merged.cp_origen);
    if (loc?.ciudad && loc?.estado) {
      merged.ciudad_origen = `${loc.ciudad}, ${loc.estado}`;
    }
  }

  return merged;
}

export async function enrichAddressLocations(formData = {}) {
  const merged = { ...formData };
  return fixLocationConsistency(merged);
}

// ─────────────────────────────────────────────────────────────────────────────
// GEOCODIFICACIÓN PROACTIVA (mensaje corto, colonia ya guardada, CP disponible)
// Aplica cuando el cliente responde un solo campo y ya tenemos su CP
// ─────────────────────────────────────────────────────────────────────────────

async function tryGeoFromColoniaShort({ chatId, sender, merged, fieldToFill, value }) {
  const isColonia = fieldToFill === 'colonia_destino' || fieldToFill === 'colonia_origen';
  if (!isColonia) return false;

  const cpKey = fieldToFill === 'colonia_destino' ? 'cp_destino' : 'cp_origen';
  const ciudadKey = fieldToFill === 'colonia_destino' ? 'ciudad_destino' : 'ciudad_origen';
  const tipo = fieldToFill === 'colonia_destino' ? 'destino' : 'origen';

  // Solo intentar si ya tenemos el CP y aún no tenemos ciudad
  if (!merged[cpKey] || merged[ciudadKey]) return false;

  const loc = await resolveLocationSmart(value, merged[cpKey]);
  if (!loc?.ciudad || !loc?.estado) return false;

  const ciudadDetectada = `${loc.ciudad}, ${loc.estado}`;

  await updateSession(chatId, {
    pending_location: { type: tipo, value: ciudadDetectada },
  });

  await sender.sendText(chatId,
    `Detecté para ${tipo.toUpperCase()}:\n\n📍 ${ciudadDetectada}\n\n¿Es correcto?\n1️⃣ Sí\n2️⃣ No`
  );

  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAwaitingAddress(ctx) {
  const { chatId, text, session, sender } = ctx;
  if (!text) return;

  let form_data = session.form_data || {};
  const { pending_location } = session;

  // ── Confirmar ciudad detectada por geo ──────────────────────────────────
  if (pending_location) {
    const answer = text.trim();

    if (answer === '1' || /^s[ií]/i.test(answer)) {
      const field = pending_location.type === 'destino' ? 'ciudad_destino' : 'ciudad_origen';
      const updated = { ...form_data, [field]: pending_location.value };

      await updateSession(chatId, { form_data: updated, pending_location: null });
      await sender.sendText(chatId, 'Perfecto 👍');

      const missingAfterConfirm = getMissingFields(updated);
      if (missingAfterConfirm.length > 0) {
        await updateSession(chatId, { current_field: missingAfterConfirm[0] });
        await sender.sendText(chatId, buildAddressForm(missingAfterConfirm));
        return;
      }

      return handleAwaitingAddress({
        ...ctx,
        text: '__continuar__',
        session: { ...session, form_data: updated, pending_location: null },
      });
    }

    if (answer === '2' || /^no$/i.test(answer)) {
      await updateSession(chatId, { pending_location: null });
      const field = pending_location.type === 'destino' ? 'ciudad_destino' : 'ciudad_origen';
      await sender.sendText(chatId,
        `Por favor escribe la *ciudad y estado* manualmente (ej: ${field === 'ciudad_destino' ? 'Guadalajara, Jalisco' : 'Monterrey, Nuevo León'})`
      );

      await updateSession(chatId, {
        current_field: field
      });

      return;
    }

    // Respuesta no reconocida — repetir confirmación
    await sender.sendText(chatId,
      `Responde:\n1️⃣ Sí\n2️⃣ No\n\n¿Es correcto *${pending_location.value}*?`
    );
    return;
  }

  // ── Preservar medidas/peso si no vienen en form_data actual ─────────────
  if (!form_data.medidas && session.form_data?.medidas) {
    form_data = {
      ...form_data,
      medidas: session.form_data.medidas,
      largo: session.form_data.largo,
      ancho: session.form_data.ancho,
      alto: session.form_data.alto,
      peso: session.form_data.peso,
    };
  }

  let merged = { ...form_data };
  const missingBefore = getMissingFields(merged);
  const value = text.trim();

  // ── Determinar si es formato libre (multi-línea o mensaje largo) ─────────
  const lineCount = text.split('\n').filter(l => l.trim()).length;
  const hasFormatoLibre =
    /remitente|destinatario|origen|destino|colonia|calle|cp|tel|cel/i.test(text) ||
    lineCount >= 2;

  if (hasFormatoLibre) {
    const libreData = parseFormatoLibre(text);

    // 🔥 SI detectamos múltiples campos → NO usar flujo campo por campo
    const detectedFields = Object.keys(libreData).filter(k => libreData[k]);

    if (detectedFields.length >= 2) {

      // merge directo
      Object.assign(merged, libreData);

      // limpiar datos inválidos
      merged = await fixLocationConsistency(merged);

      const missingAfter = getMissingFields(merged);

      await updateSession(chatId, { form_data: merged });

      if (missingAfter.length > 0) {
        await sender.sendText(chatId, buildAddressForm(missingAfter));
        return;
      }

      // 🔥 TODO COMPLETO → continuar flujo normal
      return handleAwaitingAddress({
        ...ctx,
        text: '__continuar__',
        session: { ...session, form_data: merged }
      });
    }

    // Limpiar contenido inválido del parser
    if (libreData.contenido) {
      const lower = libreData.contenido.toLowerCase().trim();
      const prohibidas = ['destinatario', 'remitente', 'paquete', 'producto'];
      if (prohibidas.includes(lower) || lower.length < 3) delete libreData.contenido;
    }

    // Geocodificación previa al merge — DESTINO
    if (!merged.ciudad_destino && libreData.colonia_destino) {
      const cp = libreData.cp_destino || merged.cp_destino;
      const loc = await resolveAddressLocation(libreData.colonia_destino, cp);
      if (loc?.ciudad && loc?.estado) {
        const ciudadDetectada = `${loc.ciudad}, ${loc.estado}`;
        await updateSession(chatId, {
          pending_location: { type: 'destino', value: ciudadDetectada },
        });
        await sender.sendText(chatId,
          `Detecté para DESTINO:\n\n📍 ${ciudadDetectada}\n\n¿Es correcto?\n1️⃣ Sí\n2️⃣ No`
        );
        return;
      }
    }

    // Geocodificación previa al merge — ORIGEN
    if (!merged.ciudad_origen && libreData.colonia_origen) {
      const cp = libreData.cp_origen || merged.cp_origen;
      const loc = await resolveAddressLocation(libreData.colonia_origen, cp);
      if (loc?.ciudad && loc?.estado) {
        const ciudadDetectada = `${loc.ciudad}, ${loc.estado}`;
        await updateSession(chatId, {
          pending_location: { type: 'origen', value: ciudadDetectada },
        });
        await sender.sendText(chatId,
          `Detecté para ORIGEN:\n\n📍 ${ciudadDetectada}\n\n¿Es correcto?\n1️⃣ Sí\n2️⃣ No`
        );
        return;
      }
    }

    // Merge protegido: no sobreescribir campos ya válidos
    Object.keys(libreData).forEach(key => {
      if (merged[key]) return;
      if (key.includes('ciudad') && libreData[key]?.length < 4) return;
      if (key.includes('colonia') && libreData[key]?.length < 3) return;
      merged[key] = libreData[key];
    });

    // Protección cruzada: evitar confundir colonia con ciudad
    if (merged.ciudad_origen && merged.colonia_origen === merged.ciudad_origen) delete merged.colonia_origen;
    if (merged.ciudad_destino && merged.colonia_destino === merged.ciudad_destino) delete merged.colonia_destino;

    // Intentar resolver ciudad de destino desde colonia si aún falta
    if (merged.cp_destino && merged.colonia_destino && !merged.ciudad_destino) {
      const loc = await resolveAddressLocation(merged.colonia_destino, merged.cp_destino);
      if (loc?.ciudad && loc?.estado) {
        merged.ciudad_destino = `${loc.ciudad}, ${loc.estado}`;
      }
    }

    // Intentar resolver ciudad de origen desde colonia si aún falta
    if (merged.cp_origen && merged.colonia_origen && !merged.ciudad_origen) {
      const loc = await resolveAddressLocation(merged.colonia_origen, merged.cp_origen);
      if (loc?.ciudad && loc?.estado) {
        merged.ciudad_origen = `${loc.ciudad}, ${loc.estado}`;
      }
    }

  } else {
    // ── Mensaje corto: asignar campo por campo ───────────────────────────
    const fieldToFill = session.current_field || missingBefore[0];

    if (fieldToFill) {
      // Intentar geocodificar proactivamente si el campo es una colonia
      // y ya tenemos el CP correspondiente
      const geoHandled = await tryGeoFromColoniaShort({
        chatId, sender, merged, fieldToFill, value,
      });

      if (geoHandled) {
        // Guardar la colonia antes de salir para que pending_location tenga contexto
        merged[fieldToFill] = value;
        await updateSession(chatId, { form_data: merged });
        return;
      }

      // Asignación normal con validación
      const assigned = await assignRequestedFieldValue({
        chatId,
        sender,
        fieldToFill,
        value,
        merged
      });
      if (!assigned) {
        await updateSession(chatId, {
          form_data: merged,
          current_field: fieldToFill
        });
        return;
      }

      merged = await fixLocationConsistency(merged);
      const missingAfterShort = getMissingFields(merged);

      await updateSession(chatId, {
        form_data: merged,
        current_field: missingAfterShort[0] || null,
      });

      if (missingAfterShort.length > 0) {
        await sender.sendText(chatId, buildAddressForm(missingAfterShort));
        return;
      }
    }
  }

  // ── Reparar ciudades sospechosas con geocodificación post-merge ──────────
  merged = await fixLocationConsistency(merged);

  // ── Confirmar si la ciudad se resolvió automáticamente y es nueva ────────
  // (aplica para el caso de formato libre sin geo previa)
  if (merged.colonia_destino && isSuspiciousCity(merged.ciudad_destino)) {
    const loc = await resolveAddressLocation(merged.colonia_destino, merged.cp_destino);
    if (loc?.ciudad && loc?.estado) {
      const ciudadDetectada = `${loc.ciudad}, ${loc.estado}`;
      await updateSession(chatId, {
        form_data: merged,
        pending_location: { type: 'destino', value: ciudadDetectada },
      });
      await sender.sendText(chatId,
        `Detecté para DESTINO:\n\n📍 ${ciudadDetectada}\n\n¿Es correcto?\n1️⃣ Sí\n2️⃣ No`
      );
      return;
    }
  }

  // ── Evaluar campos faltantes tras el merge ───────────────────────────────
  if (merged.colonia_origen && isSuspiciousCity(merged.ciudad_origen)) {
    const loc = await resolveAddressLocation(merged.colonia_origen, merged.cp_origen);
    if (loc?.ciudad && loc?.estado) {
      const ciudadDetectada = `${loc.ciudad}, ${loc.estado}`;
      await updateSession(chatId, {
        form_data: merged,
        pending_location: { type: 'origen', value: ciudadDetectada },
      });
      await sender.sendText(chatId,
        `DetectÃ© para ORIGEN:\n\nðŸ“ ${ciudadDetectada}\n\nÂ¿Es correcto?\n1ï¸âƒ£ SÃ­\n2ï¸âƒ£ No`
      );
      return;
    }
  }

  const missingAfter = getMissingFields(merged);
  await updateSession(chatId, { form_data: merged });

  if (missingAfter.length > 0) {
    logger.debug({ chatId, missingAfter }, 'Campos faltantes en AWAITING_ADDRESS');

    await updateSession(chatId, {
      current_field: missingAfter[0]
    });

    await sender.sendText(chatId, buildAddressForm(missingAfter));
    return;
  }

  // ── Formulario completo: notificar al admin y pausar ─────────────────────
  const {
    selected_carrier,
    total_amount,
    invoice_required,
    billable_weight,
    oversize_charge
  } = session;

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
        oversize: (oversize_charge || 0) > 0,
      },
      invoice: invoice_required,
    });

    await sender.sendText(config.admin.jid, adminSummary);

    await sender.sendText(chatId,
      `✅ *Tu solicitud fue enviada correctamente*\n\nTu guía será generada por un asesor.\n\n📲 En breve recibirás atención personalizada.`
    );

    await transitionState(chatId, 'AWAITING_ADDRESS', 'PAUSED', { form_data: merged });
    await startPause(chatId, folio, ctx.pushName || chatId);
    return;
  }

  // Si por algún motivo no hay carrier (flujo alternativo), volver a selección
  await transitionState(chatId, 'AWAITING_ADDRESS', 'AWAITING_SELECTION', { form_data: merged });
  await sender.sendText(chatId,
    'Perfecto 👍 Ya tengo todos los datos.\n\nAhora confirma tu paquetería escribiendo el número o nombre de la opción que elegiste.'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS USADOS POR s4_selection.js
// ─────────────────────────────────────────────────────────────────────────────

export function needsAddressCollection(formData) {
  return getMissingFields(formData).length > 0;
}

export function buildInitialAddressRequest(formData) {
  return buildAddressForm(getMissingFields(formData));
}

export const __private__ = {
  buildAddressForm,
  getMissingFields,
  isSuspiciousCity,
};

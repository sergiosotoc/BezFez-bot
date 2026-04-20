/* src/fsm/states/s2_parsing.js */

import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseFlexibleInput,
  detectUserInput,
  mergeFormData,
  getMissingFields,
  getMissingFieldMessage,
  parseFormatoLibre,
} from '../../parsers/formParser.js';
import { validateField } from '../../validators/formValidator.js';

const defaultDeps = {
  transitionState,
  updateSession,
  parseFlexibleInput,
  detectUserInput,
  mergeFormData,
  getMissingFields,
  getMissingFieldMessage,
  validateField,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extrae datos de dirección de un mensaje largo.
 * Útil cuando el cliente manda todo el formulario de una vez en PARSING_DATA.
 */
function extractAddressData(text) {
  if (!text || text.length < 30) return {};

  const libreData = parseFormatoLibre(text);
  const addressFields = [
    'nombre_origen', 'calle_origen', 'colonia_origen', 'ciudad_origen', 'cp_origen', 'cel_origen',
    'nombre_destino', 'calle_destino', 'colonia_destino', 'ciudad_destino', 'cp_destino', 'cel_destino',
    'contenido',
  ];

  const extracted = {};
  for (const field of addressFields) {
    if (libreData[field]) extracted[field] = libreData[field];
  }

  return extracted;
}

/**
 * Si las dimensiones llegaron como string "30x20x15", las descompone.
 */
function rescueDimensions(data) {
  if (data.largo && data.ancho && data.alto) return data;

  if (data.medidas) {
    const parts = data.medidas
      .split(/[x×*]/i)
      .map(n => parseFloat(n.trim()));

    if (parts.length === 3 && parts.every(n => !isNaN(n) && n > 0)) {
      return { ...data, largo: parts[0], ancho: parts[1], alto: parts[2] };
    }
  }

  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maneja el estado PARSING_DATA: acumula datos del cliente hasta tener
 * los 4 campos mínimos (cp_origen, cp_destino, medidas, peso).
 *
 * Cuando están completos, transiciona a AWAITING_INVOICE.
 * Si siguen faltando datos, pide el siguiente campo faltante.
 */
// src/fsm/states/s2_parsing.js

export async function handleParsingData(ctx, deps = defaultDeps) {
  const { chatId, text, session, sender } = ctx;
  const {
    transitionState: transitionStateFn,
    updateSession: updateSessionFn,
    parseFlexibleInput: parseFlexibleInputFn,
    detectUserInput: detectUserInputFn,
    mergeFormData: mergeFormDataFn,
    getMissingFields: getMissingFieldsFn,
    getMissingFieldMessage: getMissingFieldMessageFn,
    validateField: validateFieldFn,
  } = deps;
  if (!text) return;

  const prevData = session?.form_data || {};

  // Parsear el mensaje actual con múltiples estrategias
  const parsed = parseFlexibleInputFn(text);
  const detection = await detectUserInputFn(text);

  // Caso especial: el cliente envía solo un CP de 5 dígitos
  if (/^\d{5}$/.test(text.trim())) {
    if (!prevData.cp_origen) {
      parsed.cp_origen = text.trim();
    } else if (!prevData.cp_destino) {
      parsed.cp_destino = text.trim();
    }
  }

  // Merge acumulativo
  let merged = mergeFormDataFn(prevData, parsed);

  if (detection.hasAnyData) {
    merged = mergeFormDataFn(merged, detection.data);
  }

  // Si el mensaje es largo, buscar también datos de dirección
  if (text.length > 50) {
    const addressData = extractAddressData(text);
    if (Object.keys(addressData).length > 0) {
      merged = mergeFormData(merged, addressData);
    }
  }

  // 1. Primero normalizar medidas
  merged = rescueDimensions(merged);

  // 2. Normalizar string de medidas
  if (merged.medidas) {
    merged.medidas = merged.medidas.replace(/\s+/g, '');
  }


  // 3. Validar después
  const cleanMerged = {};
  Object.keys(merged).forEach(key => {
    if (validateFieldFn(key, merged[key])) {
      cleanMerged[key] = merged[key];
    } else {
      // 🔥 LOG CRÍTICO PARA TESTING
      console.log('INVALID FIELD:', key, merged[key]);
    }
  });

  // Persistir estado actualizado
  await updateSessionFn(chatId, { form_data: cleanMerged });

  // Verificar si ya tenemos todo lo necesario
  const missing = getMissingFieldsFn(cleanMerged);

  if (missing.length === 0) {
    const { success } = await transitionStateFn(
      chatId,
      'PARSING_DATA',
      'AWAITING_INVOICE',
      {
        form_data: cleanMerged,
        selected_carrier: null,
        invoice_required: null,
        billable_weight: null,
        oversize_charge: 0,
        total_amount: null,
        pending_selection: null,
        pending_location: null,
        current_field: null,
      }
    );

    if (success) {
      await sender.sendText(
        chatId,
        '¡Perfecto! Ya tengo todos los datos 📦\n\n¿Necesitas *factura* (con IVA)?\n1️⃣ Sí\n2️⃣ No'
      );
    }
    return;
  }

  // Pedir el siguiente campo faltante
  await sender.sendText(chatId, getMissingFieldMessageFn(missing));
}

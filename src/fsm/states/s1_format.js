/* src/fsm/states/s1_format.js */

import { updateSession } from '../../services/supabase.js';
import {
  parseFlexibleInput,
  getMissingFieldMessage,
  detectUserInput,
  mergeFormData,
  parseFormatoLibre,
} from '../../parsers/formParser.js';

const defaultDeps = {
  updateSession,
  parseFlexibleInput,
  getMissingFieldMessage,
  detectUserInput,
  mergeFormData,
};

// ─────────────────────────────────────────────────────────────────────────────
// MENSAJES
// ─────────────────────────────────────────────────────────────────────────────

export const WELCOME_MESSAGE = `¡Hola! 👋 Bienvenido a *Envíos BezFez* 📦
_"Fácil, rápido y seguro – ¡Envía con confianza!"_

Te ayudaré a cotizar y generar tu guía de envío en simples pasos:

📋 *PASO 1 – COTIZACIÓN RÁPIDA*
Solo necesito 4 datos para cotizarte al instante:

• *Medidas* del paquete (largo x alto x ancho en cm)
• *Peso* (en kg)
• *CP de origen* (código postal de 5 dígitos)
• *CP de destino* (código postal de 5 dígitos)

Puedes enviármelos así:
_Medidas: 30x20x15_
_Peso: 3kg_
_CP origen: 64000_
_CP destino: 06600_

¡O en un solo mensaje si prefieres! 😊`;

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valida que los 4 campos mínimos para cotizar estén presentes.
 * Retorna un arreglo con los nombres de los campos faltantes.
 */
function validateInitialData(data) {
  const missing = [];
  if (!/^\d{5}$/.test(data.cp_origen || ''))  missing.push('cp_origen');
  if (!/^\d{5}$/.test(data.cp_destino || '')) missing.push('cp_destino');
  if (!data.medidas || !data.largo)            missing.push('medidas');
  if (!data.peso || data.peso <= 0)            missing.push('peso');
  return missing;
}

/**
 * Intenta extraer datos de dirección completos del primer mensaje del cliente.
 * Solo se activa en mensajes largos (≥30 chars) que probablemente son formulario libre.
 */
function extractAddressDataFromInitialMessage(text) {
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

  // También capturar medidas y peso si los encontró el parser libre
  if (libreData.medidas) extracted.medidas = libreData.medidas;
  if (libreData.largo)   extracted.largo   = libreData.largo;
  if (libreData.ancho)   extracted.ancho   = libreData.ancho;
  if (libreData.alto)    extracted.alto    = libreData.alto;
  if (libreData.peso)    extracted.peso    = libreData.peso;

  return extracted;
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL (estado IDLE)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maneja el primer contacto del cliente.
 *
 * Flujo:
 * 1. Si el mensaje no es texto, pedir texto.
 * 2. Intentar extraer datos básicos (medidas, peso, CPs) y de dirección.
 * 3. Si hay datos válidos:
 *    a. Si están completos → guardar en estado AWAITING_INVOICE y preguntar factura.
 *    b. Si faltan datos   → guardar en estado PARSING_DATA y pedir los faltantes.
 * 4. Si no hay datos válidos → mostrar mensaje de bienvenida.
 */
// src/fsm/states/s1_format.js

export async function handleIdle(ctx, deps = defaultDeps) {
  const { chatId, messageType, text, sender } = ctx;
  const {
    updateSession: updateSessionFn,
    parseFlexibleInput: parseFlexibleInputFn,
    getMissingFieldMessage: getMissingFieldMessageFn,
    detectUserInput: detectUserInputFn,
    mergeFormData: mergeFormDataFn,
  } = deps;

  if (messageType !== 'text') {
await sender.sendText(chatId, 'Por ahora solo puedo procesar texto 😊');
    return;
  }

  // Extraer datos básicos
  const detection = await detectUserInputFn(text);
  const parsed = parseFlexibleInputFn(text);

  // Combinar ambas fuentes
  let combined = mergeFormDataFn(parsed, detection.data);

  // Si el mensaje es largo, intentar también parseo de formato libre
  const addressData = extractAddressDataFromInitialMessage(text);
  if (Object.keys(addressData).length > 0) {
    combined = mergeFormDataFn(combined, addressData);
  }

  // ¿El mensaje tiene algo útil?
  const hasValidData =
    combined.cp_origen ||
    combined.cp_destino ||
    combined.peso ||
    combined.medidas;

  if (!hasValidData) {
    await sender.sendText(chatId, WELCOME_MESSAGE);
    return;
  }

  // Validar los 4 campos mínimos
  const missing = validateInitialData(combined);

  // Determinar el siguiente estado
  const nextState = missing.length === 0 ? 'AWAITING_INVOICE' : 'PARSING_DATA';

  await updateSessionFn(chatId, {
    state: nextState,
    form_data: combined,
    selected_carrier: null,
    invoice_required: null,
    billable_weight: null,
    oversize_charge: 0,
    total_amount: null,
    pending_selection: null,
    pending_location: null,
    current_field: null,
  });

  if (missing.length === 0) {
    await sender.sendText(
      chatId,
      '¡Perfecto! Ya tengo todos los datos del paquete 📦\n\n¿Necesitas *factura* (con IVA)?\n1️⃣ Sí\n2️⃣ No'
    );
  } else {
    await sender.sendText(chatId, getMissingFieldMessageFn(missing));
  }
}

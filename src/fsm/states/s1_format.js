/* src/fsm/states/s1_format.js */
import { updateSession } from '../../services/supabase.js';
import { 
  parseFlexibleInput, 
  getMissingFieldMessage, 
  detectUserInput,
  mergeFormData,
  parseFormatoLibre
} from '../../parsers/formParser.js';

// ─────────────────────────────────────────────────────────
// MENSAJES
// ─────────────────────────────────────────────────────────

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

export const QUICK_QUOTE_PROMPT = `Para cotizarte necesito:

📦 *Medidas* (largo x alto x ancho en cm)
⚖️ *Peso* (en kg)
📍 *CP Origen* (5 dígitos)
📍 *CP Destino* (5 dígitos)

Ejemplo: _30x20x15, 3kg, CP origen: 64000, CP destino: 06600_`;

const ERROR_NON_TEXT = 'Por ahora solo puedo procesar texto 😊 Envíame el peso, medidas y códigos postales para cotizarte.';

// ─────────────────────────────────────────────────────────
// HANDLERS
// ─────────────────────────────────────────────────────────

export async function handleIdle(ctx) {
  const { chatId, messageType, text, sender } = ctx;

  if (messageType !== 'text') {
    await sender.sendText(chatId, 'Por ahora solo puedo procesar texto 😊');
    return;
  }

  // Intentar extraer datos de dirección completos desde el primer mensaje
  const addressData = extractAddressDataFromInitialMessage(text);
  const hasAddressData = Object.keys(addressData).length > 0;

  // Detectar y parsear datos básicos (medidas, peso, CPs)
  const detection = detectUserInput(text);
  const parsed = parseFlexibleInput(text);

  // Combinar datos básicos con los detectados
  let combined = mergeFormData(parsed, detection.data);

  // Incorporar datos de dirección si existen
  if (hasAddressData) {
    combined = mergeFormData(combined, addressData);
  }

  // Verificar si hay datos válidos para cotización
  const hasValidData =
    combined.cp_origen ||
    combined.cp_destino ||
    combined.peso ||
    combined.medidas;

  if (hasValidData) {
    const missing = validateInitialData(combined);

    const nextState =
      (missing.length === 0) ? 'AWAITING_INVOICE' : 'PARSING_DATA';

    await updateSession(chatId, {
      state: nextState,
      form_data: combined,
    });

    if (missing.length === 0) {
      await sender.sendText(
        chatId,
        '¡Perfecto! Ya tengo todos los datos del paquete 📦\n\n¿Necesitas *factura* (con IVA)?\n1️⃣ Sí\n2️⃣ No'
      );
    } else {
      await sender.sendText(chatId, getMissingFieldMessage(missing));
    }

    return;
  }

  // Si no hay datos válidos, mostrar mensaje de bienvenida
  await sender.sendText(chatId, WELCOME_MESSAGE);
}


function validateInitialData(data) {
  const missing = [];

  if (!/^\d{5}$/.test(data.cp_origen || '')) missing.push('cp_origen');
  if (!/^\d{5}$/.test(data.cp_destino || '')) missing.push('cp_destino');

  if (!data.medidas || !data.largo) missing.push('medidas');

  if (!data.peso || data.peso <= 0) missing.push('peso');

  return missing;
}

export async function handleAwaitingFormat(ctx) {
  const { chatId, messageType, sender } = ctx;

  if (messageType !== 'text' && messageType !== 'conversation') {
    await sender.sendText(chatId, ERROR_NON_TEXT);
    return;
  }

  return 'PROCEED_TO_PARSING';
}

function extractAddressDataFromInitialMessage(text) {
  if (!text || text.length < 30) return {};
  
  const libreData = parseFormatoLibre(text);
  const addressFields = [
    'nombre_origen', 'calle_origen', 'colonia_origen', 'ciudad_origen', 'cp_origen', 'cel_origen',
    'nombre_destino', 'calle_destino', 'colonia_destino', 'ciudad_destino', 'cp_destino', 'cel_destino',
    'contenido'
  ];
  
  const extracted = {};
  for (const field of addressFields) {
    if (libreData[field]) {
      extracted[field] = libreData[field];
    }
  }
  
  // También extraer medidas y peso si no se capturaron antes
  if (libreData.medidas) extracted.medidas = libreData.medidas;
  if (libreData.largo) extracted.largo = libreData.largo;
  if (libreData.ancho) extracted.ancho = libreData.ancho;
  if (libreData.alto) extracted.alto = libreData.alto;
  if (libreData.peso) extracted.peso = libreData.peso;
  
  return extracted;
}
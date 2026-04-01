/* src/fsm/states/s1_format.js */
import { updateSession } from '../../services/supabase.js';
import { parseFlexibleInput, getMissingFields, getMissingFieldMessage, detectUserInput } from '../../parsers/formParser.js';

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

  // 1. Intentar detectar datos de inmediato (Incluso en el primer mensaje)
  const detection = detectUserInput(text);
  const parsed = parseFlexibleInput(text);
  const combined = { ...parsed, ...detection.data };

  // 2. Si tiene ALGO de datos (medidas, CP o peso), inicializamos la sesión con eso
  if (Object.keys(combined).length > 0) {
    const missing = getMissingFields(combined);
    
    // Si están completos, vamos a factura. Si no, a PARSING_DATA para pedir el resto.
    const nextState = (missing.length === 0) ? 'AWAITING_INVOICE' : 'AWAITING_FORMAT';

    await updateSession(chatId, {
      state: nextState,
      form_data: combined,
    });

    if (missing.length === 0) {
      await sender.sendText(chatId, '¡Perfecto! Ya tengo todos los datos del paquete 📦\n\n¿Necesitas *factura* (con IVA)?\n1️⃣ Sí\n2️⃣ No');
    } else {
      await sender.sendText(chatId, getMissingFieldMessage(missing));
    }
    return;
  }

  // 3. Si no detectó nada (solo dijo "hola"), mandar bienvenida normal
  await sender.sendText(chatId, WELCOME_MESSAGE);
}

export async function handleAwaitingFormat(ctx) {
  const { chatId, messageType, sender } = ctx;

  if (messageType !== 'text' && messageType !== 'conversation') {
    await sender.sendText(chatId, ERROR_NON_TEXT);
    return;
  }

  return 'PROCEED_TO_PARSING';
}
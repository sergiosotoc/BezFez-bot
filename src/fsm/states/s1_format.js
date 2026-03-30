/* src/fsm/states/s1_format.js */
import { updateSession } from '../../services/supabase.js';
import { parseFlexibleInput, getMissingFields, getMissingFieldMessage } from '../../parsers/formParser.js';

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
    await sender.sendText(chatId, ERROR_NON_TEXT);
    return;
  }

  const parsed = parseFlexibleInput(text);

  if (Object.keys(parsed).length > 0) {
    const missing = getMissingFields(parsed);

    await updateSession(chatId, {
      state: 'AWAITING_INVOICE',
      form_data: parsed,
    });

    if (missing.length === 0) {
      await sender.sendText(
        chatId,
        '¡Perfecto! Ya tengo todos los datos del paquete 📦\n\n¿Necesitas *factura* (con IVA)?\n1️⃣ Sí\n2️⃣ No'
      );
      return;
    }

    await sender.sendText(chatId, getMissingFieldMessage(missing));
    return;
  }

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
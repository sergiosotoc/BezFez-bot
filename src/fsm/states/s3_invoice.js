/* src/fsm/states/s3_invoice.js */
import { transitionState } from '../../services/supabase.js';
import { parseInvoiceResponse } from '../../parsers/formParser.js';
import { calcBillableWeight, buildQuotes, formatQuoteMessage } from '../../services/calculator.js';
import { config } from '../../config/index.js';
import { logger } from '../../config/logger.js';

const AMBIGUOUS_MSG = `Para darte el precio exacto necesito saber si requieres factura.

Responde:
1️⃣ Sí (con IVA)
2️⃣ No (sin IVA)`;
const MAINTENANCE_MSG = 'Lo siento, el sistema de cotizaciones no está disponible en este momento. El encargado fue notificado y te contactará a la brevedad.';

/**
 * S3: AWAITING_INVOICE
 *
 * Interpreta la respuesta de factura (Sí/No).
 * Calcula el peso facturable y construye las 3 opciones de cotización.
 * Transiciona a AWAITING_SELECTION.
 */
export async function handleAwaitingInvoice(ctx) {
  const { chatId, text, session, sender } = ctx;

  // Ignorar mensajes sin texto (imágenes, audios, mensajes de sistema, errores de sesión)
  if (!text) {
    await sender.sendText(chatId, AMBIGUOUS_MSG);
    return;
  }

  const answer = parseInvoiceResponse(text);

  if (/cuanto|precio|costo/i.test(text)) {
    await sender.sendText(
      chatId,
      'El precio depende de si requieres factura (incluye IVA). Por favor responde:\n1️⃣ Sí\n2️⃣ No'
    );
    return;
  }

  if (answer === 'ambiguous') {
    await sender.sendText(chatId, AMBIGUOUS_MSG);
    return;
  }

  const invoice = answer === 'yes';
  const { form_data } = session;

  if (!form_data) {
    await sender.sendText(
      chatId,
      'Hubo un error con tus datos. Escribe *hola* para reiniciar la cotización.'
    );
    return;
  }

  if (
    !form_data.largo ||
    !form_data.ancho ||
    !form_data.alto ||
    !form_data.peso
  ) {
    await sender.sendText(
      chatId,
      'Tus datos están incompletos. Escribe *hola* para reiniciar la cotización.'
    );
    return;
  }

  // Calcular peso facturable
  const calc = calcBillableWeight({
    largo: form_data.largo,
    ancho: form_data.ancho,
    alto: form_data.alto,
    peso: form_data.peso,
  });

  // Obtener tarifas con manejo de fallo de Sheets
  let quotes;
  try {
    quotes = await buildQuotes(calc, invoice);
  } catch (err) {
    logger.error({ err: err.message, chatId }, 'No se pudieron obtener tarifas');
    await sender.sendText(chatId, MAINTENANCE_MSG);
    // Notificar al admin
    await sender.sendText(
      config.admin.jid,
      `⚠️ El bot no puede cotizar para ${chatId}: Google Sheets no disponible y sin caché. Requiere atención manual.`
    ).catch(() => { });
    return;
  }

  // Guardar cálculo y avanzar estado
  const { success } = await transitionState(
    chatId,
    'AWAITING_INVOICE',
    'AWAITING_SELECTION',
    {
      invoice_required: invoice,
      billable_weight: calc.pesoFacturable,
      oversize_charge: calc.cargoExtra,
      // Guardar quotes en form_data para tenerlos disponibles en S4
      form_data: {
        ...form_data,
        quotes: quotes.map(q => ({ id: q.id, label: q.label, total: q.total })),
      },
    }
  );

  if (!success) return;

  const quoteMsg = formatQuoteMessage({
    pesoFacturable: calc.pesoFacturable,
    oversize: calc.oversize,
    invoice,
    quotes,
  });

  await sender.sendText(chatId, quoteMsg);
}

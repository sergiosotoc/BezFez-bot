/* src/fsm/states/s3_invoice.js */

import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseInvoiceResponse,
  detectUserInput,
  mergeFormData,
  getMissingFieldMessage,
  getMissingFields,
  parseFormatoLibre,
} from '../../parsers/formParser.js';
import { calcBillableWeight, buildQuotes, formatQuoteMessage } from '../../services/calculator.js';
import { logger } from '../../config/logger.js';

const defaultDeps = {
  transitionState,
  updateSession,
  parseInvoiceResponse,
  detectUserInput,
  mergeFormData,
  getMissingFieldMessage,
  getMissingFields,
  calcBillableWeight,
  buildQuotes,
  formatQuoteMessage,
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

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

  if (libreData.medidas) extracted.medidas = libreData.medidas;
  if (libreData.peso)    extracted.peso    = libreData.peso;

  return extracted;
}

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
// MENSAJES
// ─────────────────────────────────────────────────────────────────────────────

const AMBIGUOUS_MSG = `Para darte el precio exacto necesito saber si requieres factura.

Responde:
1️⃣ Sí (con IVA)
2️⃣ No (sin IVA)`;

const MAINTENANCE_MSG = 'Lo siento, el sistema de cotizaciones no está disponible en este momento.';

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────────────────

export async function handleAwaitingInvoice(ctx, deps = defaultDeps) {
  const { chatId, text, session, sender } = ctx;
  const {
    transitionState: transitionStateFn,
    updateSession: updateSessionFn,
    parseInvoiceResponse: parseInvoiceResponseFn,
    detectUserInput: detectUserInputFn,
    mergeFormData: mergeFormDataFn,
    getMissingFieldMessage: getMissingFieldMessageFn,
    getMissingFields: getMissingFieldsFn,
    calcBillableWeight: calcBillableWeightFn,
    buildQuotes: buildQuotesFn,
    formatQuoteMessage: formatQuoteMessageFn,
  } = deps;
  if (!text) return;

  const detection = await detectUserInputFn(text);
  let currentFormData = session?.form_data || {};

  // Enriquecer con datos de dirección si el mensaje es suficientemente largo
  if (text.length > 50) {
    const addressData = extractAddressData(text);
    if (Object.keys(addressData).length > 0) {
      currentFormData = mergeFormDataFn(currentFormData, addressData);
    }
  }

  // Enriquecer con datos básicos detectados (medidas, peso, CPs)
  if (detection.hasAnyData) {
    currentFormData = mergeFormDataFn(currentFormData, detection.data);
  }

  // Una sola llamada a updateSession consolidando todos los cambios
  await updateSessionFn(chatId, { form_data: currentFormData });

  // ── Parsear la respuesta de factura ──────────────────────────────────────
  const answer = parseInvoiceResponseFn(text);

  if (/cuanto|precio|costo/i.test(text) && answer === 'ambiguous') {
    await sender.sendText(
      chatId,
      'El precio depende de si necesitas factura. Por favor responde:\n1️⃣ Sí\n2️⃣ No'
    );
    return;
  }

  if (answer === 'ambiguous') {
    await sender.sendText(chatId, AMBIGUOUS_MSG);
    return;
  }

  const invoice = answer === 'yes';

  // ── Validar que tenemos todos los datos básicos ──────────────────────────
  const validatedData = rescueDimensions(currentFormData);
  const missing = getMissingFieldsFn(validatedData);

  if (missing.length > 0) {
    logger.warn({ chatId, missing }, 'Datos incompletos en AWAITING_INVOICE');
    await updateSessionFn(chatId, { form_data: validatedData });
    await sender.sendText(chatId, getMissingFieldMessageFn(missing));
    return;
  }

  // ── Calcular y cotizar ───────────────────────────────────────────────────
  try {
    const calc = await calcBillableWeightFn({
      largo: validatedData.largo,
      ancho: validatedData.ancho,
      alto: validatedData.alto,
      peso: validatedData.peso,
    });

    const quotes = await buildQuotesFn(calc, invoice);

    const { success } = await transitionStateFn(
      chatId,
      'AWAITING_INVOICE',
      'AWAITING_SELECTION',
      {
        invoice_required: invoice,
        billable_weight: calc.pesoACobrar,
        oversize_charge: calc.cargoExtra,
        selected_carrier: null,
        total_amount: null,
        pending_selection: null,
        pending_location: null,
        current_field: null,
        form_data: {
          ...validatedData,
          quotes: quotes.map(q => ({ id: q.id, label: q.label, total: q.total })),
        },
      }
    );

    if (!success) return;

    const quoteMsg = formatQuoteMessageFn({
      pesoACobrar: calc.pesoACobrar,
      oversize: calc.oversize,
      invoice,
      quotes,
    });

    await sender.sendText(chatId, quoteMsg);

  } catch (err) {
    logger.error({ err: err.message, chatId }, 'Error en buildQuotes');
    await sender.sendText(chatId, MAINTENANCE_MSG);
  }
}

/* src/fsm/states/s3_invoice.js */

import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseInvoiceResponse,
  detectUserInput,
  mergeFormData,
  getMissingFieldMessage,
  getMissingFields,
  parseFormatoLibre
} from '../../parsers/formParser.js';
import { calcBillableWeight, buildQuotes, formatQuoteMessage } from '../../services/calculator.js';
import { logger } from '../../config/logger.js';

function extractAddressData(text) {
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

  if (libreData.medidas) extracted.medidas = libreData.medidas;
  if (libreData.peso) extracted.peso = libreData.peso;

  return extracted;
}

const AMBIGUOUS_MSG = `Para darte el precio exacto necesito saber si requieres factura.

Responde:
1️⃣ Sí (con IVA)
2️⃣ No (sin IVA)`;

const MAINTENANCE_MSG = 'Lo siento, el sistema de cotizaciones no está disponible en este momento.';

function rescueDimensions(data) {
  if (data.largo && data.ancho && data.alto)
    return data;

  if (data.medidas) {
    const parts = data.medidas
      .split(/[x×*]/i)
      .map(n => parseFloat(n.trim()));

    if (parts.length === 3 && parts.every(n => !isNaN(n) && n > 0)) {
      return {
        ...data,
        largo: parts[0],
        ancho: parts[1],
        alto: parts[2],
      };
    }
  }

  return data;
}

export async function handleAwaitingInvoice(ctx) {
  const {
    chatId,
    text,
    session,
    sender } = ctx;
  if (!text)
    return;

  const detection = detectUserInput(text);
  let currentFormData = session?.form_data || {};

  if (text.length > 50) {
    const addressData = extractAddressData(text);
    if (Object.keys(addressData).length > 0) {
      currentFormData = mergeFormData(currentFormData, addressData);
    }
  }

  if (detection.hasAnyData) {
    currentFormData = mergeFormData(currentFormData, detection.data);
    await updateSession(
      chatId,
      {
        form_data: currentFormData
      });
  }

  await updateSession(chatId, { form_data: currentFormData });


  const answer = parseInvoiceResponse(text);

  if (/cuanto|precio|costo/i.test(text) && answer === 'ambiguous') {
    await sender.sendText(
      chatId,
      'El precio depende de la factura. Por favor responde: 1️⃣ Sí o 2️⃣ No'
    );
    return;
  }

  if (answer === 'ambiguous') {
    await sender.sendText(
      chatId,
      AMBIGUOUS_MSG
    );
    return;
  }

  const invoice = answer === 'yes';

  const validatedData = rescueDimensions(currentFormData);
  const missing = getMissingFields(validatedData);

  if (missing.length > 0) {
    logger.warn({
      chatId,
      missing
    },
      'Datos incompletos detectados en AWAITING_INVOICE'
    );
    await updateSession(
      chatId,
      {
        form_data: validatedData
      });
    await sender.sendText(
      chatId,
      getMissingFieldMessage(missing)
    );
    return;
  }

  try {
    const calc = calcBillableWeight({
      largo: validatedData.largo,
      ancho: validatedData.ancho,
      alto: validatedData.alto,
      peso: validatedData.peso,
    });

    const quotes = await buildQuotes(calc, invoice);

    const { success } = await transitionState(
      chatId,
      'AWAITING_INVOICE',
      'AWAITING_SELECTION',
      {
        invoice_required: invoice,
        billable_weight: calc.pesoFacturable,
        oversize_charge: calc.cargoExtra,
        form_data: {
          ...validatedData,
          quotes: quotes.map(q => ({
            id: q.id,
            label: q.label,
            total: q.total
          })),
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

    await sender.sendText(
      chatId,
      quoteMsg
    );
  } catch (err) {
    logger.error({
      err: err.message,
      chatId
    },
      'Error en buildQuotes'
    );
    await sender.sendText(
      chatId,
      MAINTENANCE_MSG
    );
  }
}
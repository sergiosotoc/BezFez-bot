/* src/fsm/states/s2_parsing.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseForm,
  parsePartialResponse,
  detectUserInput,
  mergeFormData,
  getMissingFields,
  getMissingFieldMessage,
} from '../../parsers/formParser.js';

const INVOICE_QUESTION = `¿Necesitas factura?\n1. Sí\n2. No`;

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

export async function handleParsingData(ctx) {
  const { chatId, text, session, sender } = ctx;
  if (!text) return;

  const prevData = session?.form_data || {};

  let { data: parsed } = parseForm(text);
  const detection = detectUserInput(text);

  let merged = mergeFormData(prevData, parsed || {});
  if (detection.hasAnyData) {
    merged = mergeFormData(merged, detection.data);
  }

  merged = rescueDimensions(merged);

  await updateSession(chatId, { form_data: merged });

  const missing = getMissingFields(merged);

  if (missing.length === 0) {
    const { success } = await transitionState(
      chatId,
      'AWAITING_FORMAT',
      'AWAITING_INVOICE',
      { form_data: merged }
    );

    if (success) {
      await sender.sendText(chatId, INVOICE_QUESTION);
    }
    return;
  }

  await sender.sendText(chatId, getMissingFieldMessage(missing));
}

async function advanceToInvoice(ctx, formData) {
  const { chatId, sender } = ctx;

  const safeData = rescueDimensions(formData);

  const { success } = await transitionState(
    chatId,
    'AWAITING_FORMAT',
    'AWAITING_INVOICE',
    { form_data: safeData }
  );

  if (!success) return;

  await sender.sendText(chatId, INVOICE_QUESTION);
}
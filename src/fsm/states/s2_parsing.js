/* src/fsm/states/s2_parsing.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseFlexibleInput,
  detectUserInput,
  mergeFormData,
  getMissingFields,
  getMissingFieldMessage,
} from '../../parsers/formParser.js';

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

  const parsed = parseFlexibleInput(text);
  const detection = detectUserInput(text);

  // 🔥 FIX CP SUELTO
  if (/^\d{5}$/.test(text.trim())) {
    if (prevData.cp_origen && !prevData.cp_destino) {
      parsed.cp_destino = text.trim();
    }
  }

  let merged = mergeFormData(prevData, parsed);

  if (detection.hasAnyData) {
    merged = mergeFormData(merged, detection.data);
  }

  const cleanMerged = rescueDimensions(merged);

  await updateSession(chatId, { form_data: cleanMerged });

  const missing = getMissingFields(cleanMerged);

  if (missing.length === 0) {
    const { success } = await transitionState(
      chatId,
      'PARSING_DATA',
      'AWAITING_INVOICE',
      { form_data: cleanMerged }
    );

    if (success) {
      await sender.sendText(
        chatId,
        '¿Necesitas factura?\n1️⃣ Sí\n2️⃣ No'
      );
    }
    return;
  }

  await sender.sendText(chatId, getMissingFieldMessage(missing));
}
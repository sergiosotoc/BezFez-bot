import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseForm,
  parsePartialResponse,
  parseFlexibleInput,
  detectUserInput,
  mergeFormData,
  getMissingFields,
  getMissingFieldMessage,
} from '../../parsers/formParser.js';

const INVOICE_QUESTION = `¿Necesitas factura?\n1. Sí\n2. No`;

export async function handleParsingData(ctx) {
  const { chatId, text, session, sender } = ctx;

  if (!text) return;

  const prevData = session?.form_data || null;
  const prevMissing = prevData ? getMissingFields(prevData) : null;

  // ── 1. Parse tradicional
  let { data: parsed } = parseForm(text);

  // ── 2. 🔥 Parse flexible (NUEVO)
  const detection = detectUserInput(text);

  if (detection.hasAnyData) {
    parsed = mergeFormData(parsed, detection.data);
  }

  // ── 3. Si solo falta 1 campo → intentar respuesta directa
  if (prevMissing && prevMissing.length === 1) {
    const partialFound = parsePartialResponse(text, prevMissing);

    if (Object.keys(partialFound).length > 0) {
      const merged = mergeFormData(prevData, partialFound);
      const stillMissing = getMissingFields(merged);

      if (stillMissing.length === 0) {
        return await advanceToInvoice(ctx, merged);
      }

      await updateSession(chatId, { form_data: merged });
      await sender.sendText(chatId, getMissingFieldMessage(stillMissing));
      return;
    }
  }

  // ── 4. Merge total
  const merged = mergeFormData(prevData, parsed);
  const missing = getMissingFields(merged);

  if (missing.length === 0) {
    return await advanceToInvoice(ctx, merged);
  }

  // ── 5. Guardar progreso y pedir faltantes
  await updateSession(chatId, { form_data: merged });
  await sender.sendText(chatId, getMissingFieldMessage(missing));
}

// ─────────────────────────────────────────

async function advanceToInvoice(ctx, formData) {
  const { chatId, sender } = ctx;

  const { success } = await transitionState(
    chatId,
    'AWAITING_FORMAT',
    'AWAITING_INVOICE',
    { form_data: formData }
  );

  if (!success) return;

  await sender.sendText(chatId, INVOICE_QUESTION);
}
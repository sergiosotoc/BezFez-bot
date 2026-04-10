/* src/fsm/states/s2_parsing.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import {
  parseFlexibleInput,
  detectUserInput,
  mergeFormData,
  getMissingFields,
  getMissingFieldMessage,
  parseFormatoLibre
} from '../../parsers/formParser.js';

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
  
  return extracted;
}

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

  // Intentar parsear input básico
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

  // 🆕 Extraer datos de dirección si el mensaje es largo
  if (text.length > 50) {
    const addressData = extractAddressData(text);
    if (Object.keys(addressData).length > 0) {
      merged = mergeFormData(merged, addressData);
    }
  }

  // Rescatar dimensiones si vienen como string
  const cleanMerged = rescueDimensions(merged);

  // Actualizar sesión con datos combinados
  await updateSession(chatId, { form_data: cleanMerged });

  // Validar campos faltantes
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
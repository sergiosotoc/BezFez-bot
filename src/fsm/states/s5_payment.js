/* src/fsm/states/s5_payment.js */
import { transitionState, saveFileUpload, updateOrderStatus } from '../../services/supabase.js';
import { uploadComprobante } from '../../services/storage.js';
import { formatAdminSummary } from '../../services/calculator.js';
import { startPause } from '../../services/deadman.js';
import { config } from '../../config/index.js';
import { logger } from '../../config/logger.js';

const NOT_FILE_MSG = 'Aún no recibo tu comprobante. Por favor envía la *foto* o el *PDF* de tu transferencia para procesar el pedido.';
const UPLOAD_ERROR_MSG = 'Hubo un error al recibir tu comprobante. Por favor intenta enviarlo de nuevo.';
const RECEIVED_MSG = '✅ *Comprobante recibido.* Validaremos tu pago a la brevedad. ¡Gracias!';

const VALID_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'application/pdf',
]);

/**
 * S5: AWAITING_PAYMENT
 *
 * Espera una imagen o PDF del comprobante.
 * 1. Valida que sea imagen o PDF
 * 2. Descarga el buffer del mensaje de Baileys
 * 3. Sube a Supabase Storage con reintentos exponenciales
 * 4. Guarda URL en file_uploads
 * 5. Notifica al admin con resumen + forward del comprobante
 * 6. Transiciona a PAUSED y arranca el deadman switch
 */
export async function handleAwaitingPayment(ctx) {
  const { chatId, clientPhone, messageType, message, rawMessage, session, sender } = ctx;

  // ── 1. Validar tipo de mensaje ────────────────────────
  const fileBuffer = await extractFileBuffer(messageType, rawMessage);
  if (!fileBuffer) {
    await sender.sendText(chatId, NOT_FILE_MSG);
    return;
  }

  const { buffer, mimeType } = fileBuffer;
  const { form_data, selected_carrier, total_amount, invoice_required,
          billable_weight, oversize_charge } = session;
  const folio = form_data?.current_folio;

  if (!form_data || !form_data.current_folio) {
    await sender.sendText(
      chatId,
      UPLOAD_ERROR_MSG
    );
    return;
  }

  if (!folio) {
    logger.error({ chatId }, 'No se encontró folio en session.form_data');
    await sender.sendText(chatId, UPLOAD_ERROR_MSG);
    return;
  }

  // ── 2. Subir comprobante con reintentos ───────────────
  let storageUrl;
  try {
    storageUrl = await uploadComprobante(buffer, folio, mimeType);
  } catch (err) {
    logger.error({ chatId, folio, err: err.message }, 'Upload falló después de todos los reintentos');
    await sender.sendText(chatId, UPLOAD_ERROR_MSG);
    return;
  }

  // ── 3. Persistir URL y actualizar estado del pedido ───
  await saveFileUpload({ folio, storageUrl, mimeType, fileSize: buffer.length });
  await updateOrderStatus(folio, 'PAYMENT_RECEIVED');

  // ── 4. Confirmar al cliente ───────────────────────────
  await sender.sendText(chatId, RECEIVED_MSG);

  // ── 5. Notificar al admin ─────────────────────────────
  const adminSummary = formatAdminSummary({
    folio,
    carrier:   selected_carrier,
    total:     total_amount,
    clientJid:   chatId,
    clientPhone: clientPhone,
    formData:    form_data,
    calc: {
      pesoFacturable: billable_weight,
      oversize:       (oversize_charge || 0) > 0,
    },
    invoice: invoice_required,
  });

  await sender.forwardMessage(config.admin.jid, rawMessage, adminSummary);

  // ── 6. Transicionar a PAUSED ──────────────────────────
  const { success } = await transitionState(chatId, 'AWAITING_PAYMENT', 'PAUSED');
  if (!success) return;

  const clientName = form_data?.nombre_origen || chatId;
  await startPause(chatId, folio, clientName);
}

// ── Helper: extrae buffer según tipo de mensaje ───────────

async function extractFileBuffer(messageType, rawMessage) {
  const { downloadMediaMessage } = await import('@whiskeysockets/baileys');

  let mimeType;

  if (messageType === 'imageMessage') {
    mimeType = rawMessage.message?.imageMessage?.mimetype || 'image/jpeg';
  } else if (messageType === 'documentMessage') {
    mimeType = rawMessage.message?.documentMessage?.mimetype || 'application/pdf';
  } else {
    return null; // texto, contacto, audio, etc.
  }

  if (!VALID_MIME_TYPES.has(mimeType)) return null;

  const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
  return { buffer, mimeType };
}

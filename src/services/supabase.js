/* src/services/supabase.js */
import { createClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

// ── Cliente único (singleton) ─────────────────────────────
export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  { auth: { persistSession: false } }
);

// ─────────────────────────────────────────────────────────
// SESSIONS
// ─────────────────────────────────────────────────────────

/**
 * Obtiene o crea la sesión para un chat.
 * Si no existe, la inicializa en estado IDLE.
 */
export async function getOrCreateSession(chatId) {
  const { data, error } = await supabase
    .from('sessions')
    .select('*')
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error) throw error;

  if (data) return data;

  const { data: created, error: createErr } = await supabase
    .from('sessions')
    .insert({ chat_id: chatId, state: 'IDLE' })
    .select()
    .single();

  if (createErr) throw createErr;
  return created;
}

/**
 * Transición de estado con bloqueo optimista.
 *
 * Solo hace el UPDATE si el estado actual en BD coincide con `fromState`.
 * Si otra instancia ya avanzó el estado, devuelve { success: false }.
 *
 * @param {string} chatId
 * @param {string} fromState - Estado esperado antes de la transición
 * @param {string} toState   - Estado destino
 * @param {object} extra     - Columnas adicionales a actualizar (form_data, etc.)
 * @returns {{ success: boolean, session: object|null }}
 */
export async function transitionState(chatId, fromState, toState, extra = {}) {
  const { data, error } = await supabase
    .from('sessions')
    .update({ state: toState, ...extra })
    .eq('chat_id', chatId)
    .eq('state', fromState)   // <── bloqueo optimista
    .select()
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    logger.warn({ chatId, fromState, toState }, 'Optimistic lock miss — estado ya fue modificado');
    return { success: false, session: null };
  }

  return { success: true, session: data };
}

/**
 * Actualiza campos de la sesión sin cambiar el estado (p.ej. form_data parcial).
 */
export async function updateSession(chatId, fields) {
  const { data, error } = await supabase
    .from('sessions')
    .update(fields)
    .eq('chat_id', chatId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

/**
 * Retorna todas las sesiones en estado PAUSED que aún no han expirado.
 * Usado en el boot-recovery del deadman switch.
 */
export async function getActivePausedSessions() {
  const { data, error } = await supabase
    .from('sessions')
    .select('chat_id, pause_expires_at, form_data')
    .eq('state', 'PAUSED')
    .gt('pause_expires_at', new Date().toISOString());

  if (error) throw error;
  return data || [];
}

/**
 * Marca una sesión como IDLE (fin de pausa o nueva cotización).
 */
export async function resetSession(chatId) {
  const { error } = await supabase
    .from('sessions')
    .update({
      state: 'IDLE',
      form_data: null,
      selected_carrier: null,
      invoice_required: null,
      billable_weight: null,
      oversize_charge: 0,
      total_amount: null,
      paused_at: null,
      pause_expires_at: null,
    })
    .eq('chat_id', chatId);

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────
// ORDERS
// ─────────────────────────────────────────────────────────

/**
 * Genera un folio único PED-XXXXXX (6 dígitos aleatorios).
 * Reintenta si hay colisión (extremadamente improbable a 20-50 pedidos/día).
 */
export async function createOrder(orderData) {
  let attempts = 0;
  while (attempts < 5) {
    const folio = `PED-${String(Math.floor(100000 + Math.random() * 900000))}`;
    const { data, error } = await supabase
      .from('orders')
      .insert({ folio, ...orderData })
      .select()
      .single();

    if (!error) return data;

    // 23505 = unique_violation en PostgreSQL
    if (error.code !== '23505') throw error;
    attempts++;
  }
  throw new Error('No se pudo generar un folio único después de 5 intentos');
}

/**
 * Actualiza el estado de un pedido (p.ej. PENDING_PAYMENT → PAYMENT_RECEIVED).
 */
export async function updateOrderStatus(folio, status) {
  const { error } = await supabase
    .from('orders')
    .update({ status })
    .eq('folio', folio);

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────
// FILE UPLOADS
// ─────────────────────────────────────────────────────────

export async function saveFileUpload({ folio, storageUrl, mimeType, fileSize }) {
  const { error } = await supabase
    .from('file_uploads')
    .insert({ folio, storage_url: storageUrl, mime_type: mimeType, file_size: fileSize });

  if (error) throw error;
}

// ─────────────────────────────────────────────────────────
// DEDUPLICACIÓN DE MENSAJES
// ─────────────────────────────────────────────────────────

/**
 * Intenta registrar un messageId como procesado.
 * Devuelve true si es nuevo (debe procesarse), false si ya existía (duplicado).
 *
 * TTL de 5 minutos: limpieza periódica en background via cleanExpiredMessages().
 */
export async function markMessageProcessed(messageId, chatId) {
  const { error } = await supabase
    .from('processed_messages')
    .insert({ message_id: messageId, chat_id: chatId });

  if (!error) return true; // mensaje nuevo

  // 23505 = unique_violation → ya procesado
  if (error.code === '23505') return false;

  throw error;
}

/**
 * Borra mensajes procesados con más de TTL ms de antigüedad.
 * Llamar periódicamente (cada ~5 minutos).
 */
export async function cleanExpiredMessages() {
  const cutoff = new Date(Date.now() - config.processedMsgTtlMs).toISOString();
  const { error } = await supabase
    .from('processed_messages')
    .delete()
    .lt('processed_at', cutoff);

  if (error) logger.warn({ err: error }, 'Error limpiando processed_messages');
}

// ─────────────────────────────────────────────────────────
// ADMIN PAUSES (auditoría)
// ─────────────────────────────────────────────────────────

export async function recordPauseExtension(chatId, newExpiresAt) {
  const { error } = await supabase
    .from('admin_pauses')
    .insert({ chat_id: chatId, new_expires_at: newExpiresAt.toISOString() });

  if (error) logger.warn({ err: error }, 'Error guardando extensión de pausa');
}

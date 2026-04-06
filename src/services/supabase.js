/* src/services/supabase.js */
import { createClient } from '@supabase/supabase-js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

export const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceRoleKey,
  { auth: { persistSession: false } }
);


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

export async function transitionState(chatId, fromState, toState, extra = {}) {
  const { data, error } = await supabase
    .from('sessions')
    .update({ state: toState, ...extra })
    .eq('chat_id', chatId)
    .eq('state', fromState)
    .select()
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    logger.warn({ chatId, fromState, toState }, 'Optimistic lock miss — estado ya fue modificado');
    return { success: false, session: null };
  }

  return { success: true, session: data };
}

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

export async function getActivePausedSessions() {
  const { data, error } = await supabase
    .from('sessions')
    .select('chat_id, pause_expires_at, form_data')
    .eq('state', 'PAUSED')
    .gt('pause_expires_at', new Date().toISOString());

  if (error) throw error;
  return data || [];
}

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

    if (error.code !== '23505') throw error;
    attempts++;
  }
  throw new Error('No se pudo generar un folio único después de 5 intentos');
}

export async function updateOrderStatus(folio, status) {
  const { error } = await supabase
    .from('orders')
    .update({ status })
    .eq('folio', folio);

  if (error) throw error;
}

export async function saveFileUpload({ folio, storageUrl, mimeType, fileSize }) {
  const { error } = await supabase
    .from('file_uploads')
    .insert({ folio, storage_url: storageUrl, mime_type: mimeType, file_size: fileSize });

  if (error) throw error;
}

export async function markMessageProcessed(messageId, chatId) {
  const { error } = await supabase
    .from('processed_messages')
    .insert({ message_id: messageId, chat_id: chatId });

  if (!error) return true;

  if (error.code === '23505') return false;

  throw error;
}

export async function cleanExpiredMessages() {
  const cutoff = new Date(Date.now() - config.processedMsgTtlMs).toISOString();
  const { error } = await supabase
    .from('processed_messages')
    .delete()
    .lt('processed_at', cutoff);

  if (error) logger.warn({ err: error }, 'Error limpiando processed_messages');
}

export async function recordPauseExtension(chatId, newExpiresAt) {
  const { error } = await supabase
    .from('admin_pauses')
    .insert({ chat_id: chatId, new_expires_at: newExpiresAt.toISOString() });

  if (error) logger.warn({ err: error }, 'Error guardando extensión de pausa');
}

export async function isSessionExpired(chatId, ttlMs = 60 * 60 * 1000) {
  const { data, error } = await supabase
    .from('sessions')
    .select('updated_at, state')
    .eq('chat_id', chatId)
    .maybeSingle();

  if (error || !data) return false;
  if (data.state === 'IDLE' || data.state === 'PAUSED') return false;

  const lastActivity = new Date(data.updated_at).getTime();
  return (Date.now() - lastActivity) > ttlMs;
}
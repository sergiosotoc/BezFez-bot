/* src/fsm/states/s4_selection.js */

import { transitionState, updateSession } from '../../services/supabase.js';
import { parseCarrierSelection } from '../../parsers/formParser.js';
import { needsAddressCollection, buildInitialAddressRequest, enrichAddressLocations } from './s4b_address.js';
import { formatAdminSummary } from '../../services/calculator.js';
import { startPause } from '../../services/deadman.js';
import { config } from '../../config/index.js';

const defaultDeps = {
  transitionState,
  updateSession,
  parseCarrierSelection,
  needsAddressCollection,
  buildInitialAddressRequest,
  enrichAddressLocations,
  formatAdminSummary,
  startPause,
  adminJid: config.admin.jid,
};

const UNKNOWN_SELECTION_MSG = (quotes) => {
  const lines = [
    'No entendí tu selección 🤔',
    'Puedes responder con:',
    '• El número (1, 2 o 3)',
    '• El nombre (Ej: "FedEx")',
    '• O algo como "la más barata"',
    '',
  ];

  for (const q of quotes) {
    lines.push(`${q.id}. ${q.label}: $${q.total}`);
  }

  return lines.join('\n');
};

export async function handleAwaitingSelection(ctx, deps = defaultDeps) {
  const { chatId, text, session, sender, clientPhone, pushName } = ctx;
  const {
    transitionState: transitionStateFn,
    updateSession: updateSessionFn,
    parseCarrierSelection: parseCarrierSelectionFn,
    needsAddressCollection: needsAddressCollectionFn,
    buildInitialAddressRequest: buildInitialAddressRequestFn,
    enrichAddressLocations: enrichAddressLocationsFn = async data => data,
    formatAdminSummary: formatAdminSummaryFn,
    startPause: startPauseFn,
    adminJid,
  } = deps;

  if (!text) return;

  const {
    form_data,
    invoice_required,
    billable_weight,
    oversize_charge,
    pending_selection,
  } = session;

  if (!form_data || !form_data.quotes) {
    await sender.sendText(
      chatId,
      'La cotización no está disponible. Escribe *hola* para reiniciar el proceso.'
    );
    return;
  }

  const quotes = form_data.quotes;

  let selection = null;

  // ─────────────────────────────────────────
  // MANEJO DE AMBIGÜEDAD
  // ─────────────────────────────────────────

  if (pending_selection === 'estafeta') {

    const num = Number(text.trim());

    if (num === 1) {
      selection = { id: 1, label: 'Estafeta Express' };
    } else if (num === 2) {
      selection = { id: 2, label: 'Estafeta Terrestre' };
    }

    else if (/express|exp|rapido|rápido/i.test(text)) {
      selection = { id: 1, label: 'Estafeta Express' };
    } else if (/terrestre|terr/i.test(text)) {
      selection = { id: 2, label: 'Estafeta Terrestre' };
    } else {
      await sender.sendText(
        chatId,
        'Perfecto 👍\n\n¿Deseas *Estafeta Express* 🚀 o *Estafeta Terrestre* 🚚?\n\nResponde: 1 o 2\nEXPRESS o TERRESTRE'
      );
      return;
    }
  }

  if (pending_selection === 'terrestre') {

    const num = Number(text.trim());

    if (num === 2) {
      selection = { id: 2, label: 'Estafeta Terrestre' };
    } else if (num === 3) {
      selection = { id: 3, label: 'FedEx Terrestre' };
    }

    else if (/estafeta|esta/i.test(text)) {
      selection = { id: 2, label: 'Estafeta Terrestre' };
    } else if (/fedex|fed/i.test(text)) {
      selection = { id: 3, label: 'FedEx Terrestre' };
    } else {
      await sender.sendText(chatId, 'Responde: 2 o 3\nESTAFETA o FEDEX');
      return;
    }
  }

  if (selection) {
    await updateSessionFn(chatId, { pending_selection: null });
  }

  // ─────────────────────────────────────────
  // PARSEO NORMAL
  // ─────────────────────────────────────────

  if (!selection) {
    const parsed = parseCarrierSelectionFn(text);

    // 🔥 PRIORIDAD 1: selección directa (número o match exacto)
    if (parsed?.id) {
      selection = parsed;
    }

    // 🔥 PRIORIDAD 2: ambigüedad
    else if (parsed?.ambiguous === 'terrestre') {
      await updateSessionFn(chatId, { pending_selection: 'terrestre' });
      await sender.sendText(
        chatId,
        '¿Prefieres *Estafeta Terrestre* 🚚 o *FedEx Terrestre* 📦?\n\nResponde: ESTAFETA o FEDEX'
      );
      return;
    }

    else if (parsed?.ambiguous === true) {
      await updateSessionFn(chatId, { pending_selection: 'estafeta' });
      await sender.sendText(
        chatId,
        '¿Deseas *Estafeta Express* 🚀 o *Estafeta Terrestre* 🚚?\n\nResponde: EXPRESS o TERRESTRE'
      );
      return;
    }

    // 🔥 fallback
    if (!parsed) {
      await sender.sendText(chatId, UNKNOWN_SELECTION_MSG(quotes));
      return;
    }

    selection = parsed;
  }

  const chosen = quotes.find(q => Number(q.id) === Number(selection.id));

  if (!chosen) {
    await sender.sendText(chatId, UNKNOWN_SELECTION_MSG(quotes));
    return;
  }

  // ─────────────────────────────────────────
  // VALIDACIÓN FINAL (CRÍTICO)
  // ─────────────────────────────────────────

  const enrichedFormData = await enrichAddressLocationsFn(form_data);

  if (needsAddressCollectionFn(enrichedFormData)) {
    const { success } = await transitionStateFn(
      chatId,
      'AWAITING_SELECTION',
      'AWAITING_ADDRESS',
      {
        selected_carrier: chosen.label,
        total_amount: chosen.total,
        pending_selection: null,
        form_data: enrichedFormData,
      }
    );

    if (!success) return;

    await sender.sendText(chatId, buildInitialAddressRequestFn(enrichedFormData));
    return;
  }

  // ─────────────────────────────────────────
  // TODO COMPLETO → ENVIAR AL ADMIN
  // ─────────────────────────────────────────

  const folio = `PED-${Date.now()}`;

  const adminSummary = formatAdminSummaryFn({
    folio,
    carrier: chosen.label,
    total: chosen.total,
    clientJid: chatId,
    clientPhone,
    pushName,
    formData: enrichedFormData,
    calc: {
      pesoFacturable: billable_weight,
      oversize: (oversize_charge || 0) > 0,
    },
    invoice: invoice_required,
  });

  // 📩 Enviar al admin
  await sender.sendText(adminJid, adminSummary);

  // 📲 Notificar cliente
  await sender.sendText(
    chatId,
    `✅ *Tu solicitud fue enviada correctamente*

Tu guía será generada por un asesor.

📲 En breve recibirás atención personalizada.
Si hay algún ajuste en el precio, se te notificará antes de generar la guía.`
  );

  // ⏸️ Pasar a PAUSED
  const { success } = await transitionStateFn(
    chatId,
    'AWAITING_SELECTION',
    'PAUSED'
  );

  if (!success) return;

  // ⏱️ Activar deadman
  await startPauseFn(chatId, folio, pushName || chatId);
}

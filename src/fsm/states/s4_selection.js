/* src/fsm/states/s4_selection.js */
import { transitionState, updateSession } from '../../services/supabase.js';
import { parseCarrierSelection } from '../../parsers/formParser.js';
import { formatPaymentMessage } from '../../services/calculator.js';
import { createOrder } from '../../services/supabase.js';
import { needsAddressCollection, buildInitialAddressRequest } from './s4b_address.js';

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

export async function handleAwaitingSelection(ctx) {
  const { chatId, text, session, sender } = ctx;

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

  if (pending_selection === 'estafeta') {
    if (/express|exp|rapido|rápido/i.test(text)) {
      selection = { id: 1, label: 'Estafeta Express' };
    } else if (/terrestre|terr/i.test(text)) {
      selection = { id: 2, label: 'Estafeta Terrestre' };
    } else {
      await sender.sendText(
        chatId,
        'Perfecto 👍\n\n¿Deseas *Estafeta Express* 🚀 (más rápido) o *Estafeta Terrestre* 🚚 (más económico)?\n\nResponde: EXPRESS o TERRESTRE'
      );
      return;
    }
  }

  if (pending_selection === 'terrestre') {
    if (/estafeta|esta/i.test(text)) {
      selection = { id: 2, label: 'Estafeta Terrestre' };
    } else if (/fedex|fed/i.test(text)) {
      selection = { id: 3, label: 'FedEx Terrestre' };
    } else {
      await sender.sendText(chatId, 'Responde: *ESTAFETA* 🚚 o *FEDEX* 📦');
      return;
    }
  }

  if (selection) {
    await updateSession(chatId, { pending_selection: null });
  }

  if (!selection) {
    const parsed = parseCarrierSelection(text);

    if (parsed?.ambiguous === 'terrestre') {
      await updateSession(chatId, { pending_selection: 'terrestre' });
      await sender.sendText(
        chatId,
        '¿Prefieres *Estafeta Terrestre* 🚚 o *FedEx Terrestre* 📦?\n\nResponde: ESTAFETA o FEDEX'
      );
      return;
    }

    if (parsed?.ambiguous === true) {
      await updateSession(chatId, { pending_selection: 'estafeta' });
      await sender.sendText(
        chatId,
        '¿Deseas *Estafeta Express* 🚀 o *Estafeta Terrestre* 🚚?\n\nResponde: EXPRESS o TERRESTRE'
      );
      return;
    }

    if (!parsed) {
      await sender.sendText(chatId, UNKNOWN_SELECTION_MSG(quotes));
      return;
    }

    selection = parsed;
  }

  const chosen = quotes.find(q => q.id === selection.id);

  if (!chosen) {
    await sender.sendText(chatId, UNKNOWN_SELECTION_MSG(quotes));
    return;
  }

  if (needsAddressCollection(form_data)) {
    console.log('Form data before address collection:', form_data);

    const { success } = await transitionState(
      chatId,
      'AWAITING_SELECTION',
      'AWAITING_ADDRESS',
      {
        selected_carrier: chosen.label,
        total_amount: chosen.total,
        pending_selection: null,
        form_data: form_data,
      }
    );

    if (!success) return;

    await sender.sendText(chatId, buildInitialAddressRequest(form_data));
    return;
  }

  const order = await createOrder({
    chat_id: chatId,
    carrier: chosen.label,
    total_amount: chosen.total,
    invoice_required,
    billable_weight,
    oversize_charge,
    form_snapshot: form_data,
    status: 'PENDING_PAYMENT',
  });

  const { success } = await transitionState(
    chatId,
    'AWAITING_SELECTION',
    'AWAITING_PAYMENT',
    {
      selected_carrier: chosen.label,
      total_amount: chosen.total,
      pending_selection: null,
      form_data: { ...form_data, current_folio: order.folio },
    }
  );

  if (!success) return;

  const paymentMsg = formatPaymentMessage(order.folio, chosen.total);
  await sender.sendText(chatId, paymentMsg);
}
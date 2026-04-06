/* src/fsm/machine.js */
import { getOrCreateSession, resetSession, isSessionExpired } from '../services/supabase.js';
import { handleIdle, handleAwaitingFormat } from './states/s1_format.js';
import { handleParsingData } from './states/s2_parsing.js';
import { handleAwaitingInvoice } from './states/s3_invoice.js';
import { handleAwaitingSelection } from './states/s4_selection.js';
import { handleAwaitingAddress } from './states/s4b_address.js';
import { handleAwaitingPayment } from './states/s5_payment.js';
import { handlePaused } from './states/s6_paused.js';
import { logger } from '../config/logger.js';

export async function dispatch(ctx) {
  const { chatId } = ctx;

  const expired = await isSessionExpired(chatId);
  if (expired) {
    logger.info({ chatId }, 'Sesión expirada por inactividad — reseteando');
    await resetSession(chatId);
  }

  const session = await getOrCreateSession(chatId);
  ctx.session = session;

  logger.debug({ chatId, state: session.state, msgType: ctx.messageType }, 'FSM dispatch');

  switch (session.state) {
    case 'IDLE':
      return handleIdle(ctx);

    case 'AWAITING_FORMAT': {
      const result = await handleAwaitingFormat(ctx);
      if (result === 'PROCEED_TO_PARSING') {
        return handleParsingData(ctx);
      }
      return;
    }

    case 'PARSING_DATA':
      return handleParsingData(ctx);

    case 'AWAITING_INVOICE':
      return handleAwaitingInvoice(ctx);

    case 'AWAITING_SELECTION':
      return handleAwaitingSelection(ctx);

    case 'AWAITING_ADDRESS':          // ← NUEVO
      return handleAwaitingAddress(ctx);

    case 'AWAITING_PAYMENT':
      return handleAwaitingPayment(ctx);

    case 'PAUSED':
      return handlePaused(ctx);

    default:
      logger.warn({ chatId, state: session.state }, 'Estado FSM desconocido — reseteando a IDLE');
      return handleIdle(ctx);
  }
}
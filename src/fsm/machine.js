/* src/fsm/machine.js */

import { getOrCreateSession, resetSession, isSessionExpired } from '../services/supabase.js';
import { handleIdle } from './states/s1_format.js';
import { handleParsingData } from './states/s2_parsing.js';
import { handleAwaitingInvoice } from './states/s3_invoice.js';
import { handleAwaitingSelection } from './states/s4_selection.js';
import { handleAwaitingAddress } from './states/s4b_address.js';
import { handlePaused } from './states/s6_paused.js';
import { logger } from '../config/logger.js';

/**
 * Despachador central de la FSM.
 * Carga la sesión desde Supabase, evalúa expiración por inactividad
 * y rutea al handler correcto según el estado actual.
 */
export async function dispatch(ctx) {
  const { chatId } = ctx;

  // Expiración por inactividad (TTL de 1 hora en estados activos)
  const expired = await isSessionExpired(chatId);
  if (expired) {
    logger.info({ chatId }, 'Sesión expirada por inactividad — reseteando a IDLE');
    await resetSession(chatId);
  }

  const session = await getOrCreateSession(chatId);
  ctx.session = session;

  logger.debug({ chatId, state: session.state, msgType: ctx.messageType }, 'FSM dispatch');

  switch (session.state) {
    case 'IDLE':
      return handleIdle(ctx);

    case 'PARSING_DATA':
      return handleParsingData(ctx);

    case 'AWAITING_INVOICE':
      return handleAwaitingInvoice(ctx);

    case 'AWAITING_SELECTION':
      return handleAwaitingSelection(ctx);

    case 'AWAITING_ADDRESS':
      return handleAwaitingAddress(ctx);

    case 'PAUSED':
      return handlePaused(ctx);

    default:
      logger.warn({ chatId, state: session.state }, 'Estado FSM desconocido — reseteando a IDLE');
      await resetSession(chatId);
      return handleIdle(ctx);
  }
}
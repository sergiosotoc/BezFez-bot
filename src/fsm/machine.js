/* src/fsm/machine.js */

import { getOrCreateSession, resetSession, isSessionExpired } from '../services/supabase.js';
import { handleIdle } from './states/s1_format.js';
import { handleParsingData } from './states/s2_parsing.js';
import { handleAwaitingInvoice } from './states/s3_invoice.js';
import { handleAwaitingSelection } from './states/s4_selection.js';
import { handleAwaitingAddress } from './states/s4b_address.js';
import { handlePaused } from './states/s6_paused.js';
import { logger } from '../config/logger.js';

const defaultDeps = {
  getOrCreateSession,
  resetSession,
  isSessionExpired,
  handleIdle,
  handleParsingData,
  handleAwaitingInvoice,
  handleAwaitingSelection,
  handleAwaitingAddress,
  handlePaused,
};

/**
 * Despachador central de la FSM.
 * Carga la sesión desde Supabase, evalúa expiración por inactividad
 * y rutea al handler correcto según el estado actual.
 */
export async function dispatch(ctx, deps = defaultDeps) {
  const { chatId } = ctx;
  const {
    getOrCreateSession: getOrCreateSessionFn,
    resetSession: resetSessionFn,
    isSessionExpired: isSessionExpiredFn,
    handleIdle: handleIdleFn,
    handleParsingData: handleParsingDataFn,
    handleAwaitingInvoice: handleAwaitingInvoiceFn,
    handleAwaitingSelection: handleAwaitingSelectionFn,
    handleAwaitingAddress: handleAwaitingAddressFn,
    handlePaused: handlePausedFn,
  } = deps;

  // Expiración por inactividad (TTL de 1 hora en estados activos)
  const expired = await isSessionExpiredFn(chatId);
  if (expired) {
    logger.info({ chatId }, 'Sesión expirada por inactividad — reseteando a IDLE');
    await resetSessionFn(chatId);
  }

  const session = await getOrCreateSessionFn(chatId);
  ctx.session = session;

  logger.debug({ chatId, state: session.state, msgType: ctx.messageType }, 'FSM dispatch');

  switch (session.state) {
    case 'IDLE':
      return handleIdleFn(ctx);

    case 'PARSING_DATA':
      return handleParsingDataFn(ctx);

    case 'AWAITING_INVOICE':
      return handleAwaitingInvoiceFn(ctx);

    case 'AWAITING_SELECTION':
      return handleAwaitingSelectionFn(ctx);

    case 'AWAITING_ADDRESS':
      return handleAwaitingAddressFn(ctx);

    case 'PAUSED':
      return handlePausedFn(ctx);

    default:
      logger.warn({ chatId, state: session.state }, 'Estado FSM desconocido — reseteando a IDLE');
      await resetSessionFn(chatId);
      return handleIdleFn(ctx);
  }
}

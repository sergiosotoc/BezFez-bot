/* src/fsm/states/s6_paused.js */
/**
 * S6: PAUSED
 *
 * El bot está en modo suspensión — el encargado está atendiendo al cliente.
 * Cualquier mensaje del cliente durante este estado es ignorado silenciosamente
 * para no interferir con la atención manual.
 *
 * La reactivación la gestiona deadman.js cuando expira el timer.
 */
export async function handlePaused(_ctx) {
  // No hacer nada intencionalmente.
  // Si el encargado quiere extender, escribe EXTENDER en el número admin.
  // Eso lo maneja el router de admin (bot/router.js), no la FSM del cliente.
}

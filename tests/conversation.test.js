import { handleIdle } from '../src/fsm/states/s1_format.js';
import { handleParsingData } from '../src/fsm/states/s2_parsing.js';
import { handleAwaitingInvoice } from '../src/fsm/states/s3_invoice.js';

// ─────────────────────────────────────────
// 🧪 MOCK DE SESIÓN (SIMULA SUPABASE)
// ─────────────────────────────────────────

let session = {
  state: 'IDLE',
  form_data: {}
};

// Mock sender (simula WhatsApp)
const sender = {
  sendText: async (chatId, msg) => {
    console.log(`\n🤖 BOT:\n${msg}`);
  }
};

// Mock ctx dinámico
function createCtx(text) {
  return {
    chatId: 'test-user',
    text,
    sender,
    session
  };
}

// ─────────────────────────────────────────
// 🔥 SIMULADOR DE FLUJO
// ─────────────────────────────────────────

async function dispatch(ctx) {
  switch (session.state) {
    case 'IDLE':
      await handleIdle(ctx);
      break;
    case 'PARSING_DATA':
      await handleParsingData(ctx);
      break;
    case 'AWAITING_INVOICE':
      await handleAwaitingInvoice(ctx);
      break;
  }
}

// ─────────────────────────────────────────
// 🧪 CONVERSACIÓN REAL
// ─────────────────────────────────────────

const conversation = [
  'hola',
  '30x20x15',
  '5kg',
  '44100',
  '06600',
  'si'
];

for (const msg of conversation) {
  console.log(`\n👤 USER:\n${msg}`);

  const ctx = createCtx(msg);

  await dispatch(ctx);

  // 🔥 actualizar sesión manualmente (simulando DB)
  if (ctx.session) {
    session = ctx.session;
  }
}
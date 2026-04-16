import { handleParsingData } from '../src/fsm/states/s2_parsing.js';

const fakeSender = {
  sendText: async (chatId, msg) => {
    console.log('\nBOT RESPONDE:\n', msg);
  }
};

const ctx = {
  chatId: 'test-chat',
  text: '30x20x15 3kg 44100 06600',
  session: { form_data: {} },
  sender: fakeSender
};

await handleParsingData(ctx);
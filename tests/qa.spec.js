import assert from 'node:assert/strict';

process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'test-service-role';
process.env.ADMIN_PHONE = process.env.ADMIN_PHONE || '5512345678';

const { normalizePhone } = await import('../src/parsers/formParser.js');
const parser = await import('../src/parsers/formParser.js');
const { validateField } = await import('../src/validators/formValidator.js');
const { handleIdle } = await import('../src/fsm/states/s1_format.js');
const { handleParsingData } = await import('../src/fsm/states/s2_parsing.js');
const { handleAwaitingInvoice } = await import('../src/fsm/states/s3_invoice.js');
const { handleAwaitingSelection } = await import('../src/fsm/states/s4_selection.js');
const { assignRequestedFieldValue, needsAddressCollection, buildInitialAddressRequest } = await import('../src/fsm/states/s4b_address.js');
const { dispatch: machineDispatch } = await import('../src/fsm/machine.js');
const { handlePaused } = await import('../src/fsm/states/s6_paused.js');
const router = await import('../src/bot/router.js');
const { startServer } = await import('../src/server.js');
const { formatAdminSummary } = await import('../src/services/calculator.js');

const results = [];

function createSender() {
  const messages = [];
  return {
    messages,
    async sendText(chatId, text) {
      messages.push({ chatId, text });
    },
  };
}

function lastMessage(sender) {
  return sender.messages.at(-1)?.text || '';
}

function makeTextMessage({
  chatId = '5215512345678@s.whatsapp.net',
  text = 'hola',
  id = 'msg-1',
  fromMe = false,
  pushName = 'Cliente',
  senderPn = null,
} = {}) {
  return {
    key: { remoteJid: chatId, id, fromMe, senderPn },
    message: { conversation: text },
    pushName,
  };
}

async function run(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`FAIL ${name}`);
    console.error(error.stack || error.message || String(error));
  }
}

await run('S1-01 IDLE sin datos útiles muestra bienvenida', async () => {
  const sender = createSender();
  let updated = null;

  await handleIdle(
    { chatId: 'c1', messageType: 'text', text: 'hola quiero un envio', sender },
    {
      updateSession: async (...args) => { updated = args; },
      parseFlexibleInput: () => ({}),
      getMissingFieldMessage: fields => fields.join(','),
      detectUserInput: async () => ({ hasAnyData: false, data: {} }),
      mergeFormData: (a, b) => ({ ...a, ...b }),
    }
  );

  assert.equal(updated, null);
  assert.match(lastMessage(sender), /Bienvenido|Env[ií]os BezFez/i);
});

await run('S1-02 IDLE con datos completos pasa a AWAITING_INVOICE', async () => {
  const sender = createSender();
  let updated = null;

  await handleIdle(
    {
      chatId: 'c2',
      messageType: 'text',
      text: 'Medidas: 30x20x15\nPeso: 3kg\nCP origen: 64000\nCP destino: 06600',
      sender,
    },
    {
      updateSession: async (_chatId, fields) => { updated = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
    }
  );

  assert.equal(updated.state, 'AWAITING_INVOICE');
  assert.equal(updated.form_data.cp_origen, '64000');
  assert.equal(updated.form_data.cp_destino, '06600');
  assert.equal(updated.form_data.medidas, '30x20x15');
  assert.equal(String(updated.form_data.peso), '3');
  assert.match(lastMessage(sender), /factura/i);
});

await run('S1-03 IDLE con datos parciales pasa a PARSING_DATA', async () => {
  const sender = createSender();
  let updated = null;

  await handleIdle(
    { chatId: 'c3', messageType: 'text', text: 'peso 5kg CP 64000', sender },
    {
      updateSession: async (_chatId, fields) => { updated = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
    }
  );

  assert.equal(updated.state, 'PARSING_DATA');
  assert.equal(updated.form_data.cp_origen, '64000');
  assert.equal(String(updated.form_data.peso), '5');
  assert.match(lastMessage(sender), /CP de destino|medidas/i);
});

await run('S1-04 IDLE con imagen pide texto', async () => {
  const sender = createSender();
  await handleIdle({ chatId: 'c4', messageType: 'imageMessage', text: null, sender });
  assert.match(lastMessage(sender), /solo puedo procesar texto/i);
});

await run('S1-06 parsea medidas con espacios y CPs en formato libre', async () => {
  const sender = createSender();
  let updated = null;

  await handleIdle(
    {
      chatId: 'c5',
      messageType: 'text',
      text: 'tengo una caja de 30 x 20 x 15 cm, pesa 4 kg, sale de 64000 va a 06600',
      sender,
    },
    {
      updateSession: async (_chatId, fields) => { updated = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
    }
  );

  assert.equal(updated.state, 'AWAITING_INVOICE');
  assert.equal(updated.form_data.medidas, '30x20x15');
  assert.equal(updated.form_data.cp_origen, '64000');
  assert.equal(updated.form_data.cp_destino, '06600');
  assert.equal(String(updated.form_data.peso), '4');
});

await run('S2-01 solo un CP de 5 dígitos se asigna a cp_origen', async () => {
  const sender = createSender();
  let persisted = null;

  await handleParsingData(
    { chatId: 'p1', text: '64000', session: { form_data: {} }, sender },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { persisted = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
      getMissingFields: parser.getMissingFields,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      validateField: (field, value) => field === 'cp_origen' ? true : !value,
    }
  );

  assert.equal(persisted.form_data.cp_origen, '64000');
  assert.match(lastMessage(sender), /CP de destino/i);
});

await run('S2-02 segundo CP se asigna a cp_destino', async () => {
  const sender = createSender();
  let persisted = null;

  await handleParsingData(
    { chatId: 'p2', text: '06600', session: { form_data: { cp_origen: '64000' } }, sender },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { persisted = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      detectUserInput: async () => ({ hasAnyData: false, data: {} }),
      mergeFormData: parser.mergeFormData,
      getMissingFields: parser.getMissingFields,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      validateField: (field, value) => ['cp_origen', 'cp_destino'].includes(field) ? true : !value,
    }
  );

  assert.equal(persisted.form_data.cp_destino, '06600');
  assert.match(lastMessage(sender), /medidas/i);
});

await run('S2-03 medidas con espacios se normalizan', async () => {
  const sender = createSender();
  let persisted = null;

  await handleParsingData(
    { chatId: 'p3', text: '30 x 20 x 15', session: { form_data: {} }, sender },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { persisted = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
      getMissingFields: parser.getMissingFields,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      validateField,
    }
  );

  assert.equal(persisted.form_data.medidas, '30x20x15');
  assert.equal(persisted.form_data.largo, '30');
  assert.equal(persisted.form_data.ancho, '20');
  assert.equal(persisted.form_data.alto, '15');
});

await run('S2-04 peso escrito en texto no se guarda', async () => {
  const sender = createSender();
  let persisted = null;

  await handleParsingData(
    { chatId: 'p4', text: 'cinco kilos', session: { form_data: {} }, sender },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { persisted = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
      getMissingFields: parser.getMissingFields,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      validateField: (field, value) => !!value,
    }
  );

  assert.equal(persisted.form_data.peso, undefined);
  assert.match(lastMessage(sender), /peso/i);
});

await run('S2-05 peso mayor a 1000kg se invalida', async () => {
  const sender = createSender();
  let persisted = null;

  await handleParsingData(
    { chatId: 'p5', text: 'peso: 1500kg', session: { form_data: {} }, sender },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { persisted = fields; },
      parseFlexibleInput: parser.parseFlexibleInput,
      detectUserInput: parser.detectUserInput,
      mergeFormData: parser.mergeFormData,
      getMissingFields: parser.getMissingFields,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      validateField,
    }
  );

  assert.equal(persisted.form_data.peso, undefined);
});

await run('S3-01 respuesta afirmativa genera cotización y avanza', async () => {
  const sender = createSender();
  let transition = null;

  await handleAwaitingInvoice(
    {
      chatId: 'i1',
      text: 'si',
      sender,
      session: {
        form_data: { largo: 30, ancho: 20, alto: 15, peso: 3, cp_origen: '64000', cp_destino: '06600', medidas: '30x20x15' },
      },
    },
    {
      transitionState: async (...args) => {
        transition = args;
        return { success: true };
      },
      updateSession: async () => {},
      parseInvoiceResponse: parser.parseInvoiceResponse,
      detectUserInput: async () => ({ hasAnyData: false, data: {} }),
      mergeFormData: parser.mergeFormData,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      getMissingFields: parser.getMissingFields,
      calcBillableWeight: async () => ({ pesoACobrar: 3, oversize: false, cargoExtra: 0 }),
      buildQuotes: async () => ([
        { id: 1, label: 'Estafeta Express', total: 100 },
        { id: 2, label: 'Estafeta Terrestre', total: 90 },
        { id: 3, label: 'FedEx Terrestre', total: 95 },
      ]),
      formatQuoteMessage: () => 'COTIZACION TEST',
    }
  );

  assert.equal(transition[1], 'AWAITING_INVOICE');
  assert.equal(transition[2], 'AWAITING_SELECTION');
  assert.equal(lastMessage(sender), 'COTIZACION TEST');
});

await run('S3-03 respuesta ambigua mantiene estado y pide aclaración', async () => {
  const sender = createSender();

  await handleAwaitingInvoice(
    {
      chatId: 'i2',
      text: 'tal vez',
      sender,
      session: { form_data: { largo: 30, ancho: 20, alto: 15, peso: 3, cp_origen: '64000', cp_destino: '06600', medidas: '30x20x15' } },
    },
    {
      transitionState: async () => { throw new Error('no debe transicionar'); },
      updateSession: async () => {},
      parseInvoiceResponse: parser.parseInvoiceResponse,
      detectUserInput: async () => ({ hasAnyData: false, data: {} }),
      mergeFormData: parser.mergeFormData,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      getMissingFields: parser.getMissingFields,
      calcBillableWeight: async () => { throw new Error('no debe calcular'); },
      buildQuotes: async () => [],
      formatQuoteMessage: () => '',
    }
  );

  assert.match(lastMessage(sender), /1.*Sí|1.*Si/i);
});

await run('S3-04 pregunta de precio en AWAITING_INVOICE pide definir factura', async () => {
  const sender = createSender();

  await handleAwaitingInvoice(
    {
      chatId: 'i3',
      text: 'cuánto me costaría?',
      sender,
      session: { form_data: { largo: 30, ancho: 20, alto: 15, peso: 3, cp_origen: '64000', cp_destino: '06600', medidas: '30x20x15' } },
    },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async () => {},
      parseInvoiceResponse: parser.parseInvoiceResponse,
      detectUserInput: async () => ({ hasAnyData: false, data: {} }),
      mergeFormData: parser.mergeFormData,
      getMissingFieldMessage: parser.getMissingFieldMessage,
      getMissingFields: parser.getMissingFields,
      calcBillableWeight: async () => ({ pesoACobrar: 3, oversize: false, cargoExtra: 0 }),
      buildQuotes: async () => [],
      formatQuoteMessage: () => '',
    }
  );

  assert.match(lastMessage(sender), /factura/i);
});

await run('S4-01 selección directa avanza a AWAITING_ADDRESS si faltan direcciones', async () => {
  const sender = createSender();
  let transition = null;

  await handleAwaitingSelection(
    {
      chatId: 's41',
      text: '1',
      sender,
      clientPhone: '5512345678',
      pushName: 'Juan',
      session: {
        form_data: {
          cp_origen: '64000',
          cp_destino: '06600',
          medidas: '30x20x15',
          peso: 3,
          quotes: [{ id: 1, label: 'Estafeta Express', total: 100 }],
        },
      },
    },
    {
      transitionState: async (...args) => {
        transition = args;
        return { success: true };
      },
      updateSession: async () => {},
      parseCarrierSelection: parser.parseCarrierSelection,
      needsAddressCollection: () => true,
      buildInitialAddressRequest: () => 'PIDE DIRECCION',
      formatAdminSummary: () => 'ADMIN',
      startPause: async () => {},
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.equal(transition[2], 'AWAITING_ADDRESS');
  assert.equal(lastMessage(sender), 'PIDE DIRECCION');
});

await run('S4-02 "estafeta" ambiguo pide aclaración', async () => {
  const sender = createSender();
  let pending = null;

  await handleAwaitingSelection(
    {
      chatId: 's42',
      text: 'estafeta',
      sender,
      clientPhone: '5512345678',
      pushName: 'Juan',
      session: { form_data: { quotes: [{ id: 1, label: 'Estafeta Express', total: 100 }] } },
    },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { pending = fields.pending_selection; },
      parseCarrierSelection: parser.parseCarrierSelection,
      needsAddressCollection: () => false,
      buildInitialAddressRequest: () => '',
      formatAdminSummary: () => '',
      startPause: async () => {},
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.equal(pending, 'estafeta');
  assert.match(lastMessage(sender), /Express|Terrestre/i);
});

await run('S4-03 "terrestre" ambiguo pide aclaración', async () => {
  const sender = createSender();
  let pending = null;

  await handleAwaitingSelection(
    {
      chatId: 's43',
      text: 'terrestre',
      sender,
      clientPhone: '5512345678',
      pushName: 'Juan',
      session: { form_data: { quotes: [{ id: 2, label: 'Estafeta Terrestre', total: 100 }, { id: 3, label: 'FedEx Terrestre', total: 90 }] } },
    },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async (_chatId, fields) => { pending = fields.pending_selection; },
      parseCarrierSelection: parser.parseCarrierSelection,
      needsAddressCollection: () => false,
      buildInitialAddressRequest: () => '',
      formatAdminSummary: () => '',
      startPause: async () => {},
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.equal(pending, 'terrestre');
  assert.match(lastMessage(sender), /FedEx|Estafeta/i);
});

await run('S4-04 selección incomprensible muestra opciones', async () => {
  const sender = createSender();

  await handleAwaitingSelection(
    {
      chatId: 's44',
      text: 'el azul',
      sender,
      clientPhone: '5512345678',
      pushName: 'Juan',
      session: {
        form_data: {
          quotes: [
            { id: 1, label: 'Estafeta Express', total: 100 },
            { id: 2, label: 'Estafeta Terrestre', total: 90 },
            { id: 3, label: 'FedEx Terrestre', total: 95 },
          ],
        },
      },
    },
    {
      transitionState: async () => ({ success: false }),
      updateSession: async () => {},
      parseCarrierSelection: parser.parseCarrierSelection,
      needsAddressCollection: () => false,
      buildInitialAddressRequest: () => '',
      formatAdminSummary: () => '',
      startPause: async () => {},
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.match(lastMessage(sender), /1\. Estafeta Express/);
});

await run('S4-05 sin quotes avisa reinicio', async () => {
  const sender = createSender();

  await handleAwaitingSelection({
    chatId: 's45',
    text: '1',
    sender,
    clientPhone: '5512345678',
    pushName: 'Juan',
    session: { form_data: null },
  });

  assert.match(lastMessage(sender), /hola/i);
});

await run('S4-06 selección enriquece ciudad origen antes de pedir faltantes', async () => {
  const sender = createSender();
  let transition = null;

  await handleAwaitingSelection(
    {
      chatId: 's46',
      text: '3',
      sender,
      clientPhone: '5512345678',
      pushName: 'Sergio SC',
      session: {
        form_data: {
          cp_origen: '44130',
          cp_destino: '77710',
          nombre_origen: 'Julissa Hernandez Almaraz',
          calle_origen: '.lope de vega #113',
          colonia_origen: 'arcoz Vallarta',
          cel_origen: '3317129594',
          nombre_destino: 'Aaron Guadalupe Arratia Acosta',
          calle_destino: 'Lote 3 Mza 29 fraccion.local #218',
          colonia_destino: 'playacar',
          ciudad_destino: 'Playa del Carmen, Quintana Roo',
          cel_destino: '9833761536',
          medidas: '60x40x40',
          largo: 60,
          ancho: 40,
          alto: 40,
          peso: 14,
          quotes: [{ id: 3, label: 'FedEx Terrestre', total: 395 }],
        },
      },
    },
    {
      transitionState: async (...args) => {
        transition = args;
        return { success: true };
      },
      updateSession: async () => {},
      parseCarrierSelection: parser.parseCarrierSelection,
      needsAddressCollection,
      buildInitialAddressRequest,
      enrichAddressLocations: async data => ({
        ...data,
        ciudad_origen: 'Guadalajara, Jalisco',
      }),
      formatAdminSummary: () => 'ADMIN',
      startPause: async () => {},
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.equal(transition[2], 'AWAITING_ADDRESS');
  assert.equal(transition[3].form_data.ciudad_origen, 'Guadalajara, Jalisco');
  assert.match(lastMessage(sender), /contenido/i);
  assert.doesNotMatch(lastMessage(sender), /ciudad y estado de origen/i);
});

await run('S4B-02 normalizePhone limpia prefijo +52', async () => {
  assert.equal(normalizePhone('+52 55 1234 5678'), '5512345678');
});

await run('S4B-08 parser limpia etiqueta Nombre en formato libre', async () => {
  const data = parser.parseFormatoLibre(`
ORIGEN
Nombre: Juan Perez
Calle: Reforma 123
Colonia: Centro
CP: 64000
Cel: 5512345678

DESTINO
Nombre Destino: Maria Lopez
Calle: Juarez 456
Colonia: Roma
CP: 06600
Cel: 5598765432
Contenido: ropa
`);

  assert.equal(data.nombre_origen, 'Juan Perez');
  assert.equal(data.nombre_destino, 'Maria Lopez');
});

await run('ADM-04 resumen admin limpia etiquetas en nombres guardados', async () => {
  const msg = formatAdminSummary({
    folio: 'PED-TEST',
    carrier: 'FedEx Terrestre',
    total: 100,
    clientJid: '5215512345678@s.whatsapp.net',
    clientPhone: '5512345678',
    pushName: 'Cliente',
    formData: {
      nombre_origen: 'Nombre: Juan Perez',
      calle_origen: 'Reforma 123',
      colonia_origen: 'Centro',
      ciudad_origen: 'Monterrey, Nuevo Leon',
      cp_origen: '64000',
      cel_origen: '5512345678',
      nombre_destino: 'Nombre Destino: Maria Lopez',
      calle_destino: 'Juarez 456',
      colonia_destino: 'Roma',
      ciudad_destino: 'Cuauhtemoc, Ciudad de Mexico',
      cp_destino: '06600',
      cel_destino: '5598765432',
      medidas: '30x20x15',
      peso: 3,
      contenido: 'ropa',
    },
    calc: { pesoFacturable: 3, oversize: false },
    invoice: false,
  });

  assert.match(msg, /Nombre Origen: Juan Perez/);
  assert.match(msg, /Nombre Destino: Maria Lopez/);
  assert.doesNotMatch(msg, /Nombre Origen: Nombre:/);
  assert.doesNotMatch(msg, /Nombre Destino: Nombre Destino:/);
});

await run('S4B-03 celular de 8 dígitos se rechaza', async () => {
  const sender = createSender();
  const merged = {};
  const ok = await assignRequestedFieldValue({
    chatId: 'a1',
    sender,
    fieldToFill: 'cel_destino',
    value: '12345678',
    merged,
  });

  assert.equal(ok, false);
  assert.equal(merged.cel_destino, undefined);
  assert.match(lastMessage(sender), /Teléfono inválido/i);
});

await run('S4B-06 contenido genérico se rechaza', async () => {
  const sender = createSender();
  const merged = {};
  const ok = await assignRequestedFieldValue({
    chatId: 'a2',
    sender,
    fieldToFill: 'contenido',
    value: 'paquete',
    merged,
  });

  assert.equal(ok, false);
  assert.match(lastMessage(sender), /contenido válido/i);
});

await run('S4B-07 CP inválido se rechaza', async () => {
  const sender = createSender();
  const merged = {};
  const ok = await assignRequestedFieldValue({
    chatId: 'a3',
    sender,
    fieldToFill: 'cp_destino',
    value: '1234',
    merged,
  });

  assert.equal(ok, false);
  assert.match(lastMessage(sender), /CP inválido/i);
});

await run('INF-03 /health responde 200 con JSON', async () => {
  const server = startServer(0);
  try {
    await new Promise(resolve => server.once('listening', resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(body.ts);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

await run('FSM-01 sesión expirada resetea y despacha como IDLE', async () => {
  const calls = [];
  await machineDispatch(
    { chatId: 'fsm-1', messageType: 'text', text: 'hola' },
    {
      isSessionExpired: async () => true,
      resetSession: async chatId => calls.push(['reset', chatId]),
      getOrCreateSession: async () => ({ state: 'IDLE' }),
      handleIdle: async ctx => calls.push(['idle', ctx.chatId]),
      handleParsingData: async () => calls.push(['parsing']),
      handleAwaitingInvoice: async () => calls.push(['invoice']),
      handleAwaitingSelection: async () => calls.push(['selection']),
      handleAwaitingAddress: async () => calls.push(['address']),
      handlePaused: async () => calls.push(['paused']),
    }
  );

  assert.deepEqual(calls, [['reset', 'fsm-1'], ['idle', 'fsm-1']]);
});

await run('FSM-05 error en dispatch responde mensaje genérico', async () => {
  router.__private__.resetTestState();
  const sender = createSender();

  await router.__private__.processRoute(
    makeTextMessage({ chatId: '5215511111111@s.whatsapp.net', text: 'hola mundo', id: 'fsm05' }),
    sender,
    { onWhatsApp: async () => [] },
    {
      markMessageProcessed: async () => true,
      resetSession: async () => {},
      dispatch: async () => { throw new Error('boom'); },
      extendPause: async () => {},
      endPause: async () => {},
      processRatesExcel: async () => 0,
      downloadMediaMessage: async () => Buffer.from(''),
      resetAuthStorage: async () => true,
      adminPhone: '5512345678',
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.match(lastMessage(sender), /Ocurrió un error inesperado|Ocurri/i);
});

await run('FSM-06 handlePaused ignora mensajes silenciosamente', async () => {
  const result = await handlePaused({ chatId: 'paused-1', text: 'sigues ahi?' });
  assert.equal(result, undefined);
});

await run('FSM-07 mensajes de grupo se ignoran', async () => {
  router.__private__.resetTestState();
  const sender = createSender();
  let touched = false;

  await router.__private__.processRoute(
    makeTextMessage({ chatId: 'grupo@g.us', text: 'hola grupo', id: 'group-1' }),
    sender,
    { onWhatsApp: async () => [] },
    {
      markMessageProcessed: async () => { touched = true; return true; },
      resetSession: async () => { touched = true; },
      dispatch: async () => { touched = true; },
      extendPause: async () => {},
      endPause: async () => {},
      processRatesExcel: async () => 0,
      downloadMediaMessage: async () => Buffer.from(''),
      resetAuthStorage: async () => true,
      adminPhone: '5512345678',
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.equal(touched, false);
  assert.equal(sender.messages.length, 0);
});

await run('FSM-02 mensaje duplicado se ignora silenciosamente', async () => {
  router.__private__.resetTestState();
  const sender = createSender();
  let dispatched = false;

  await router.__private__.processRoute(
    makeTextMessage({ text: 'hola', id: 'dup-1' }),
    sender,
    { onWhatsApp: async () => [] },
    {
      markMessageProcessed: async () => false,
      resetSession: async () => {},
      dispatch: async () => { dispatched = true; },
      extendPause: async () => {},
      endPause: async () => {},
      processRatesExcel: async () => 0,
      downloadMediaMessage: async () => Buffer.from(''),
      resetAuthStorage: async () => true,
      adminPhone: '5512345678',
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.equal(dispatched, false);
  assert.equal(sender.messages.length, 0);
});

await run('FSM-03 rate limit bloquea al sexto mensaje en ventana corta', async () => {
  router.__private__.resetTestState();
  for (let i = 0; i < 5; i += 1) {
    assert.equal(router.__private__.isRateLimited('spam-user'), false);
  }
  assert.equal(router.__private__.isRateLimited('spam-user'), true);
});

await run('FSM-04 JID @lid usa senderPn si existe', async () => {
  router.__private__.resetTestState();
  const phone = await router.__private__.resolveClientPhone(
    makeTextMessage({ chatId: 'abc123@lid', senderPn: '5215512345678', text: 'hola' }),
    { onWhatsApp: async () => [] }
  );

  assert.equal(phone, '5215512345678');
});

await run('S1-05 "hola" resetea sesión y reentra por dispatch', async () => {
  router.__private__.resetTestState();
  const sender = createSender();
  const calls = [];

  await router.__private__.processRoute(
    makeTextMessage({ text: 'hola', id: 'hola-1' }),
    sender,
    { onWhatsApp: async () => [] },
    {
      markMessageProcessed: async () => true,
      resetSession: async chatId => calls.push(['reset', chatId]),
      dispatch: async ctx => calls.push(['dispatch', ctx.chatId, ctx.text]),
      extendPause: async () => {},
      endPause: async () => {},
      processRatesExcel: async () => 0,
      downloadMediaMessage: async () => Buffer.from(''),
      resetAuthStorage: async () => true,
      adminPhone: '5512345678',
      adminJid: '5512345678@s.whatsapp.net',
    }
  );

  assert.deepEqual(calls, [['reset', '5215512345678@s.whatsapp.net'], ['dispatch', '5215512345678@s.whatsapp.net', 'hola']]);
});

await run('ADM-01 FINALIZADO citando ticket válido libera sesión', async () => {
  const sender = createSender();
  let ended = null;

  const wasCommand = await router.__private__.handleAdminMessage(
    {
      chatId: '5512345678@s.whatsapp.net',
      text: 'FINALIZADO',
      sender,
      rawMessage: {
        message: {
          extendedTextMessage: {
            contextInfo: {
              quotedMessage: {
                conversation: 'Ticket\nID: 5215519999999@s.whatsapp.net',
              },
            },
          },
        },
      },
    },
    {
      extendPause: async () => {},
      endPause: async target => { ended = target; },
      resetAuthStorage: async () => true,
    }
  );

  assert.equal(wasCommand, true);
  assert.equal(ended, '5215519999999@s.whatsapp.net');
  assert.match(lastMessage(sender), /liberada/i);
});

await run('ADM-02 EXTENDER sin citar mensaje pide responder al ticket', async () => {
  const sender = createSender();

  const wasCommand = await router.__private__.handleAdminMessage(
    {
      chatId: '5512345678@s.whatsapp.net',
      text: 'EXTENDER',
      sender,
      rawMessage: { message: { conversation: 'EXTENDER' } },
    },
    {
      extendPause: async () => {},
      endPause: async () => {},
      resetAuthStorage: async () => true,
    }
  );

  assert.equal(wasCommand, true);
  assert.match(lastMessage(sender), /responder.*ticket/i);
});

await run('ADM-03 RESET_AUTH confirma eliminación', async () => {
  const sender = createSender();

  const wasCommand = await router.__private__.handleAdminMessage(
    {
      chatId: '5512345678@s.whatsapp.net',
      text: 'RESET_AUTH',
      sender,
      rawMessage: { message: { conversation: 'RESET_AUTH' } },
    },
    {
      extendPause: async () => {},
      endPause: async () => {},
      resetAuthStorage: async () => true,
    }
  );

  assert.equal(wasCommand, true);
  assert.match(lastMessage(sender), /QR nuevo|eliminada/i);
});

const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;

console.log(`\nResumen QA automatizado: ${passed}/${results.length} casos pasando`);

if (failed > 0) {
  process.exit(1);
}

process.exit(0);

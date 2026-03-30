/* src/services/calculator.js */
import { config } from '../config/index.js';
import { getPreciosPorPeso } from './sheets.js';

/**
 * Calcula el peso facturable según la regla de peso volumétrico estándar.
 * Peso facturable = max(peso_bascula, L×A×A / 5000)
 * Si alguna dimensión > 100 cm → cargo adicional de $175
 */
export function calcBillableWeight({ largo, ancho, alto, peso }) {
  const pesoVolumetrico = (largo * ancho * alto) / 5000;
  const pesoFacturable  = Math.max(peso, pesoVolumetrico);
  const oversize        = Math.max(largo, ancho, alto) > config.oversizeThreshold;
  const cargoExtra      = oversize ? config.oversizeCharge : 0;

  return {
    pesoFacturable: Math.ceil(pesoFacturable * 100) / 100,
    oversize,
    cargoExtra,
  };
}

export function applyIVA(base, requiereFactura) {
  if (!requiereFactura) return base;
  return Math.ceil(base * (1 + config.iva) * 100) / 100;
}

/**
 * Construye las 3 opciones de cotización.
 * Los precios ya vienen con/sin IVA desde Sheets — solo suma el cargo extra.
 */
export async function buildQuotes({ pesoFacturable, cargoExtra }, invoice) {
  const precios = await getPreciosPorPeso(pesoFacturable, invoice);

  const carriers = [
    { id: 1, 
      label: 'Estafeta Express',   
      basePrice: precios.estafeta_express   
    },
    { id: 2, 
      label: 'Estafeta Terrestre',
       basePrice: precios.estafeta_terrestre 
      },
    { id: 3, 
      label: 'FedEx Terrestre',    
      basePrice: precios.fedex_terrestre    
    },
  ];

  return carriers.map(({ id, label, basePrice }) => ({
    id,
    label,
    basePrice,
    total: basePrice + cargoExtra,
  }));
}

export function formatQuoteMessage({ pesoFacturable, oversize, invoice, quotes }) {
  const lines = [
    '*COTIZACIÓN*',
    `Peso facturable: ${pesoFacturable}kg`,
    `Factura: ${invoice ? 'Sí' : 'No'}`,
  ];

  if (oversize) {
    lines.push(`⚠️ Cargo adicional por medidas mayores a 100cm: *$${config.oversizeCharge}*`);
  }

  lines.push('');
  for (const q of quotes) {
    lines.push(`${q.id}. ${q.label}: $${q.total}`);
  }

  lines.push('', 'Elige una opción.');
  return lines.join('\n');
}

export function formatPaymentMessage(folio, amount) {
  const { name, account, clabe, holder } = config.bank;
  return [
    '💳 *PASO 3 – PAGO SEGURO*',
    '',
    `Tu guía está lista para generarse 🎉`,
    `*Folio: ${folio}*`,
    '',
    `Realiza tu pago de *$${amount}* a través de:`,
    '',
    `🏦 *Transferencia / SPEI*`,
    `Banco: ${name}`,
    `Cuenta: ${account}`,
    `CLABE: ${clabe}`,
    `Titular: ${holder}`,
    '',
    '📸 Cuando realices el pago, envíame aquí la *foto o PDF* de tu comprobante.',
    '',
    '_Una vez confirmado el pago recibirás tu guía en PDF lista para imprimir. 📄_',
  ].join('\n');
}

/**
 * Resumen completo para el encargado.
 *
 * El chatId en cuentas nuevas de WhatsApp llega como hash@lid (identificador
 * interno) en lugar del número real. Usamos cel_origen del formulario como
 * fuente confiable del teléfono del cliente.
 */
export function formatAdminSummary({ folio, carrier, total, clientJid, clientPhone, formData, calc, invoice }) {
  const rawJid = clientJid
    .replace('@s.whatsapp.net', '')
    .replace('@lid', '');
 
  const phoneIsNumber = clientPhone && /^\d{10,15}$/.test(clientPhone);
  const phone = phoneIsNumber
    ? clientPhone
    : (formData?.cel_origen || clientPhone || rawJid);
 
  // ── Link de WhatsApp al chat del cliente ─────────────────
  // Si el teléfono es un número válido, construir el link wa.me.
  // Agrega el código de país 52 (México) si el número tiene 10 dígitos.
  let waLink = null;
  if (/^\d{10,15}$/.test(phone)) {
    const fullNumber = phone.length === 10 ? `52${phone}` : phone;
    waLink = `https://wa.me/${fullNumber}`;
  }
 
  const {
    nombre_origen, 
    calle_origen, 
    colonia_origen, 
    ciudad_origen, 
    cp_origen, 
    cel_origen,
    nombre_destino, 
    calle_destino, 
    colonia_destino, 
    ciudad_destino, 
    cp_destino, 
    cel_destino,
    medidas, peso, 
    contenido,
  } = formData;
 
  const lines = [
    '*COMPROBANTE RECIBIDO*',
    '',
    `*FOLIO:* ${folio}`,
    `*SERVICIO:* ${carrier}`,
    `*TOTAL:* $${total}`,
    '',
    `*CLIENTE:* ${nombre_origen || 'N/A'}`,
    `*TELÉFONO:* ${phone}`,
    '',
    '*COTIZACIÓN*',
    `Peso facturable: ${calc.pesoFacturable}kg`,
    `Factura: ${invoice ? 'Sí' : 'No'}`,
    `Cargo por medidas >1m: ${calc.oversize ? `Sí (+$${config.oversizeCharge})` : 'No'}`,
    '',
    '*ORIGEN*',
    `Nombre Origen: ${nombre_origen}`,
    `Calle y Número Origen: ${calle_origen}`,
    `Colonia Origen: ${colonia_origen}`,
    `Ciudad y Estado Origen: ${ciudad_origen}`,
    `CP Origen: ${cp_origen}`,
    `Cel Origen: ${cel_origen}`,
    '',
    '*DESTINO*',
    `Nombre Destino: ${nombre_destino}`,
    `Calle y Número Destino: ${calle_destino}`,
    `Colonia Destino: ${colonia_destino}`,
    `Ciudad y Estado Destino: ${ciudad_destino}`,
    `CP Destino: ${cp_destino}`,
    `Cel Destino: ${cel_destino}`,
    '',
    '*PAQUETE*',
    `Medidas (LxAxA): ${medidas}`,
    `Peso (kg): ${peso}`,
    `Contenido: ${contenido}`,
    '',
    'Adjunto comprobante enviado por el cliente.',
    '',
    // ── Link directo al chat del cliente ──────────────────
    waLink
      ? `📲 *Enviar guía al cliente:*\n${waLink}`
      : `📲 *Chat cliente:* ${clientJid}`,
  ];
 
  return lines.join('\n');
}
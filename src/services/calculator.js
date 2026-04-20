/* src/services/calculator.js */
import { config } from '../config/index.js';
import { getPreciosPorPeso, getTarifas } from './rates.js';

export async function calcBillableWeight({ largo, ancho, alto, peso }) {
  const pesoVolumetrico = (largo * ancho * alto) / 5000;
  const pesoFacturable = Math.max(peso, pesoVolumetrico);

  const tarifas = await getTarifas();

  const fila = tarifas.find(t => t.peso >= pesoFacturable)
    ?? tarifas[tarifas.length - 1];

  const pesoACobrar = fila.peso;

  const oversize = Math.max(largo, ancho, alto) >= config.oversizeThreshold;
  const cargoExtra = oversize ? config.oversizeCharge : 0;

  return {
    pesoFacturable: Math.ceil(pesoFacturable * 100) / 100,
    pesoACobrar,
    oversize,
    cargoExtra,
  };
}

export async function buildQuotes({ pesoACobrar, cargoExtra }, invoice) {
  const precios = await getPreciosPorPeso(pesoACobrar, invoice);

  const carriers = [
    {
      id: 1,
      label: 'Estafeta Express',
      basePrice: precios.estafeta_express
    },
    {
      id: 2,
      label: 'Estafeta Terrestre',
      basePrice: precios.estafeta_terrestre
    },
    {
      id: 3,
      label: 'FedEx Terrestre',
      basePrice: precios.fedex_terrestre
    },
  ];

  return carriers.map(({ id, label, basePrice }) => {
    const total = (basePrice || 0) + cargoExtra;

    return {
      id,
      label,
      basePrice,
      total: Math.ceil(total)
    };
  });
}

function cleanSummaryLabel(value, labels) {
  if (value === null || value === undefined) return value;

  const labelPattern = labels.join('|');
  return String(value)
    .replace(new RegExp(`^\\s*(?:${labelPattern})(?:\\s+(?:origen|destino|completo))?\\s*[:\\-]?\\s*`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatQuoteMessage({
  pesoACobrar,
  oversize,
  invoice,
  quotes
}) {
  const lines = [
    '*COTIZACIÓN*',
    `Peso a facturable: ${pesoACobrar}kg`,
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

export function formatAdminSummary({
  folio,
  carrier,
  total,
  clientJid,
  clientPhone,
  pushName,
  formData,
  calc,
  invoice
}) {
  const rawJid = clientJid.replace('@s.whatsapp.net', '').replace('@lid', '');
  const isRealPhone = /^\d{10,15}$/.test(clientPhone);

  let phone;

  if (isRealPhone) {
    phone = clientPhone;
  } else if (clientPhone?.startsWith('lid:')) {
    phone = `⚠️ No resuelto (${clientPhone})`;
  } else {
    phone = rawJid;
  }

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
    medidas,
    peso,
    contenido,
  } = formData;

  const clienteLabel = pushName || 'Cliente WhatsApp';
  const nombreOrigen = cleanSummaryLabel(nombre_origen, ['nombre', 'remitente', 'envia']);
  const nombreDestino = cleanSummaryLabel(nombre_destino, ['nombre', 'destinatario', 'receptor', 'recibe']);

  const lines = [
    '*COMPROBANTE RECIBIDO*',
    '',
    `*FOLIO:* ${folio}`,
    `*SERVICIO:* ${carrier}`,
    `*TOTAL:* $${total}`,
    '',
    `*CLIENTE:* ${clienteLabel}`,
    `*TELÉFONO:* ${phone}`,
    '',
    '*COTIZACIÓN*',
    `Peso facturable: ${calc.pesoFacturable}kg`,
    `Factura: ${invoice ? 'Sí' : 'No'}`,
    `Cargo por medidas >1m: ${calc.oversize ? `Sí (+$${config.oversizeCharge})` : 'No'}`,
    '',
    '*ORIGEN*',
    `Nombre Origen: ${nombreOrigen}`,
    `Calle y Número Origen: ${calle_origen}`,
    `Colonia Origen: ${colonia_origen}`,
    `Ciudad y Estado Origen: ${ciudad_origen}`,
    `CP Origen: ${cp_origen}`,
    `Cel Origen: ${cel_origen}`,
    '',
    '*DESTINO*',
    `Nombre Destino: ${nombreDestino}`,
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
    waLink
      ? `📲 *Enviar guía al cliente:*\n${waLink}`
      : `📲 *Chat cliente:* ${clientJid}`,
    '',
    `🆔 ID: ${clientJid}`
  ];

  return lines.join('\n');
}

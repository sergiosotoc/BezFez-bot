/* src/parsers/formParser.js */

function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizePhone(phone) {
  if (!phone) return null;

  let cleaned = String(phone).replace(/[\s\-().+]/g, '').replace(/\D/g, '');

  if (cleaned.startsWith('52') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  }

  return cleaned.length === 10 ? cleaned : null;
}

function extractField(originalText, normText, ...patterns) {
  for (const pattern of patterns) {
    const match = normText.match(pattern);
    if (match?.[1]) {
      const matchIndex = normText.indexOf(match[0]);
      if (matchIndex === -1) continue;
      const valueStart = matchIndex + match[0].indexOf(match[1]);
      const valueLen = match[1].length;
      return originalText.slice(valueStart, valueStart + valueLen).trim();
    }
  }
  return null;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractCP(text, side) {
  const norm = normalize(text);
  const normSide = normalize(side);
  const escapedSide = escapeRegex(normSide);

  const labeled = norm.match(
    new RegExp(`cp\\s*${escapedSide}\\s*[:\\-]?\\s*(\\d{5})`)
  );
  if (labeled) return labeled[1];

  const lines = text.split('\n');
  for (const line of lines) {
    if (!normalize(line).includes(normSide)) continue;
    const cp = line.match(/\b(\d{5})\b/);
    if (cp) return cp[1];
  }

  return null;
}

function extractMedidas(text) {
  const norm = normalize(text);

  const labeled = norm.match(
    /medidas?\s*(?:\(lxaxa\))?\s*[:\-]?\s*([\d.]+\s*[x×*]\s*[\d.]+\s*[x×*]\s*[\d.]+)(?:\s*cm)?/i
  );
  if (labeled) return labeled[1].replace(/\s/g, '');

  const bare = norm.match(/\b(\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?\s*[x×*]\s*\d+(?:\.\d+)?)(?:\s*cm)?\b/);
  return bare ? bare[1].replace(/\s/g, '') : null;
}

function parseDimensions(medidas) {
  const parts = medidas
    .split(/[x×*]/i)
    .map(n => parseFloat(n.trim()));

  if (parts.length !== 3 || parts.some(isNaN)) return null;

  const [largo, ancho, alto] = parts;

  if (
    largo <= 0 || ancho <= 0 || alto <= 0 ||
    largo > 300 || ancho > 300 || alto > 300
  ) {
    return null;
  }

  return { largo, ancho, alto };
}

function extractPeso(text) {
  const norm = normalize(text);

  const labeled = norm.match(/peso\s*(?:\(kg\))?\s*[:\-]?\s*([\d.]+)/);
  if (labeled) return parseFloat(labeled[1]);

  const natural = norm.match(/pesa\s*([\d.]+)/) ||
    norm.match(/([\d.]+)\s*kg\b/) ||
    norm.match(/([\d.]+)\s*kilos?\b/);
  if (natural) return parseFloat(natural[1]);

  return null;
}

function detectLooseNumbers(text) {
  const numbers = text.match(/\b\d{5}\b/g) || [];
  const weight = text.match(/\b(\d+(?:\.\d+)?)\s*kg?\b/i);

  const data = {};

  if (numbers.length >= 2) {
    data.cp_origen = numbers[0];
    data.cp_destino = numbers[1];
  }

  if (weight) {
    data.peso = parseFloat(weight[1]);
  }

  return data;
}

function isFormatoLibre(text) {
  const norm = normalize(text);
  return /remitente|destinatario|envia|envia desde|envia a/i.test(norm);
}

function extractBlock(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start === -1) return '';

  const afterStart = text.slice(start);
  const end = afterStart.slice(1).search(endPattern);

  if (end === -1) return afterStart;
  return afterStart.slice(0, end + 1);
}

function parsePersonBlock(block) {
  const lines = block
    .split('\n')
    .map(l => l.replace(/\*/g, '').trim())
    .filter(Boolean);

  const data = {};
  const norm = (s) => normalize(s);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const n = norm(line);

    if (/^(remitente|destinatario|envia|datos\s+de)/.test(n)) continue;


    const cpMatch = n.match(/\bc\.?\s*p\.?\s*[:\s]\s*(\d{5})\b/) ||
      n.match(/\bcp\s*[:\s]\s*(\d{5})\b/) ||
      line.match(/\b(\d{5})\b/);
    if (cpMatch && !data.cp) {
      data.cp = cpMatch[1];
      continue;
    }

    const telMatch = n.match(/(?:cel(?:ular)?|tel(?:e?fono)?|whatsapp)\s*\.?\s*[:\s]\s*([\d\s\-+()]{7,})/);
    if (telMatch && !data.cel) {
      const phone = normalizePhone(telMatch[1]);

      if (phone) {
        data.cel = phone;
      } else {
        data.invalid_phone = true;
      }

      continue;
    }

    const soloNumeros = line.replace(/[\s\-()]/g, '');
    if (/^\+?[\d]{10,15}$/.test(soloNumeros) && !data.cel) {
      const phone = normalizePhone(soloNumeros);

      if (phone) {
        data.cel = phone;
      } else {
        data.invalid_phone = true;
      }

      continue;
    }

    const colMatch = line.match(/^col(?:onia)?\.?\s+(.+)/i);
    if (colMatch && !data.colonia) {
      data.colonia = colMatch[1].trim();
      continue;
    }


    const calleMatch = line.match(/^calle\s*[:\s]\s*(.+)/i);
    if (calleMatch && !data.calle) {
      data.calle = calleMatch[1].trim();
      continue;
    }

    if (!data.calle && /(#\d|no\.?\s*\d|num\.?\s*\d|\d+(,|\s|$))/i.test(line) && !data.cp) {
      data.calle = line.trim();
      continue;
    }

    if (!data.ciudad && !data.cp &&
      /[a-záéíóúüñ]{3,}/i.test(line) &&
      !/^col/i.test(line) &&
      !/^calle/i.test(line) &&
      !/(?:cel|tel|whatsapp)/i.test(n) &&
      line.split(/\s+/).length >= 2 &&
      !/\d{5}/.test(line)) {
      if (data.nombre) {
        data.ciudad = line.trim();
        continue;
      }
    }

    if (!data.nombre &&
      /[a-záéíóúüñ]{2,}/i.test(line) &&
      !/^col/i.test(line) &&
      !/^calle/i.test(line) &&
      !/(?:cel|tel|whatsapp)/i.test(n) &&
      !/\d{5}/.test(line)) {
      data.nombre = line.trim();
      continue;
    }

    if (!data.ciudad &&
      /[a-záéíóúüñ]{3,}/i.test(line) &&
      line.split(/\s+/).length >= 2 &&
      !/\d{5}/.test(line) &&
      !/(?:cel|tel|whatsapp)/i.test(n)) {
      data.ciudad = line.trim();
    }

  }
  return data;
}

export function parseFormatoLibre(text) {
  const data = {};

  const origenBlock = extractBlock(
    text,
    /remitente|envia(nte)?|origen/i,
    /destinatario|destino|recibe/i
  );

  const destinoBlock = extractBlock(
    text,
    /destinatario|destino|recibe/i,
    /medidas|peso|contenido|paquete/i
  );

  if (origenBlock) {
    const origen = parsePersonBlock(origenBlock);
    if (origen.nombre) data.nombre_origen = origen.nombre;
    if (origen.calle) data.calle_origen = origen.calle;
    if (origen.colonia) data.colonia_origen = origen.colonia;
    if (origen.ciudad) data.ciudad_origen = origen.ciudad;
    if (origen.cp) data.cp_origen = origen.cp;
    if (origen.cel) data.cel_origen = origen.cel;
    if (origen.invalid_phone) data.invalid_phone_origen = true;
  }

  if (destinoBlock) {
    const destino = parsePersonBlock(destinoBlock);
    if (destino.nombre) data.nombre_destino = destino.nombre;
    if (destino.calle) data.calle_destino = destino.calle;
    if (destino.colonia) data.colonia_destino = destino.colonia;
    if (destino.ciudad) data.ciudad_destino = destino.ciudad;
    if (destino.cp) data.cp_destino = destino.cp;
    if (destino.cel) data.cel_destino = destino.cel;
    if (destino.invalid_phone) data.invalid_phone_destino = true;
  }

  const medidas = extractMedidas(text);
  if (medidas) {
    data.medidas = medidas;
    const dims = parseDimensions(medidas);
    if (dims) {
      data.largo = dims.largo;
      data.ancho = dims.ancho;
      data.alto = dims.alto;
    }
  }

  const pesoMatch = normalize(text).match(/(\d+(?:\.\d+)?)\s*kg/) ||
    normalize(text).match(/peso\s*[:\s]\s*(\d+(?:\.\d+)?)/);
  if (pesoMatch) {
    const peso = parseFloat(pesoMatch[1]);
    if (peso > 0 && peso <= 1000) data.peso = peso;
  }

  const contenidoMatch = text.match(/contenido\s*[:\s]\s*(.+)/i);
  if (contenidoMatch) data.contenido = contenidoMatch[1].trim();

  return data;
}

export function parseForm(text) {
  const t = text.replace(/\*/g, '').replace(/\r/g, '');
  const norm = normalize(t);

  const rawCelOrigen = extractField(t, norm,
    /cel(?:ular)?\s+origen\s*:\s*(.+)/i,
    /tel(?:e?fono)?\s+origen\s*:\s*(.+)/i);

  const rawCelDestino = extractField(t, norm,
    /cel(?:ular)?\s+destino\s*:\s*(.+)/i,
    /tel(?:e?fono)?\s+destino\s*:\s*(.+)/i);

  const cel_origen = normalizePhone(rawCelOrigen);
  const cel_destino = normalizePhone(rawCelDestino);

  if (isFormatoLibre(t)) {
    const libreData = parseFormatoLibre(t);
    if (Object.keys(libreData).length > 0) {
      const requiredFields = ['cp_origen', 'cp_destino', 'medidas', 'peso', 'largo'];
      const missing = requiredFields.filter(f => !libreData[f]);
      return { data: libreData, missing };
    }
  }

  const data = {
    nombre_origen: extractField(t, norm,
      /nombre\s+origen\s*:\s*(.+)/i),

    calle_origen: extractField(t, norm,
      /calle\s+y\s+nu?m(?:ero)?\s+origen\s*:\s*(.+)/i,
      /calle\s+origen\s*:\s*(.+)/i),

    colonia_origen: extractField(t, norm,
      /colonia\s+origen\s*:\s*(.+)/i),

    ciudad_origen: extractField(t, norm,
      /ciudad\s+y\s+estado\s+origen\s*:\s*(.+)/i,
      /ciudad\s+origen\s*:\s*(.+)/i),

    cp_origen: extractCP(t, 'origen'),

    cel_origen,

    nombre_destino: extractField(t, norm,
      /nombre\s+destino\s*:\s*(.+)/i),

    calle_destino: extractField(t, norm,
      /calle\s+y\s+nu?m(?:ero)?\s+destino\s*:\s*(.+)/i,
      /calle\s+destino\s*:\s*(.+)/i),

    colonia_destino: extractField(t, norm,
      /colonia\s+destino\s*:\s*(.+)/i),

    ciudad_destino: extractField(t, norm,
      /ciudad\s+y\s+estado\s+destino\s*:\s*(.+)/i,
      /ciudad\s+destino\s*:\s*(.+)/i),

    cp_destino: extractCP(t, 'destino'),

    cel_destino,

    medidas: extractMedidas(t),
    peso: extractPeso(t),
    contenido: extractField(t, norm, /contenido\s*:\s*(.+)/i),
  };

  if (rawCelOrigen && !cel_origen) {
    data.invalid_phone_origen = true;
  }

  if (rawCelDestino && !cel_destino) {
    data.invalid_phone_destino = true;
  }

  if (data.medidas) {
    const dims = parseDimensions(data.medidas);
    if (dims) {
      data.largo = dims.largo;
      data.ancho = dims.ancho;
      data.alto = dims.alto;
    } else {
      data.medidas = null;
      data.largo = null;
      data.ancho = null;
      data.alto = null;
    }
  }

  const requiredFields = ['cp_origen', 'cp_destino', 'medidas', 'peso', 'largo'];
  const missing = requiredFields.filter(f => !data[f]);

  return { data, missing };
}

export function mergeFormData(prev = {}, next = {}) {
  const result = { ...prev };
  Object.entries(next).forEach(([key, value]) => {
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      result[key] = value;
    }
  });
  return result;
}

export function parsePartialResponse(text, fieldKeys) {
  const t = text.replace(/\*/g, '').replace(/\r/g, '').trim();
  const lines = t.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const found = {};
  let fieldIndex = 0;

  for (const line of lines) {
    if (fieldIndex >= fieldKeys.length) break;

    const currentField = fieldKeys[fieldIndex];

    if (currentField === 'cel_origen' || currentField === 'cel_destino') {
      const phone = normalizePhone(line);

      if (phone) {
        found[currentField] = phone;
        fieldIndex++;
        continue;
      } else {
        found[`invalid_${currentField}`] = true;
        continue;
      }
    }

    if (currentField === 'cp_origen' || currentField === 'cp_destino') {
      const cp = line.match(/\b(\d{5})\b/);
      if (cp) {
        found[currentField] = cp[1];
        fieldIndex++;
        continue;
      }
    }

    if (currentField === 'medidas' || currentField === 'largo') {
      const med = extractMedidas(line);
      if (med) {
        found.medidas = med;
        const dims = parseDimensions(med);
        if (dims) {
          found.largo = dims.largo;
          found.ancho = dims.ancho;
          found.alto = dims.alto;
        }
        fieldIndex++;
        continue;
      }
    }

    if (currentField === 'peso') {
      const p = normalize(line).match(/(\d+(\.\d+)?)/);
      if (p) {
        const value = parseFloat(p[1]);
        if (value > 0 && value <= 1000) {
          found.peso = value;
          fieldIndex++;
          continue;
        }
      }
    }

    if (currentField === 'contenido') {
      if (line.length > 2) {
        found.contenido = line;
        fieldIndex++;
        continue;
      }
    }

    found[currentField] = line;
    fieldIndex++;
  }

  return found;
}


export function detectUserInput(text) {
  const data = {};
  const clean = text.replace(/\*/g, '').replace(/\r/g, '').toLowerCase().trim();

  const medMatch = clean.match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/);
  if (medMatch) {
    data.medidas = `${medMatch[1]}x${medMatch[2]}x${medMatch[3]}`;
    data.largo = parseFloat(medMatch[1]);
    data.ancho = parseFloat(medMatch[2]);
    data.alto = parseFloat(medMatch[3]);
  }

  const pesoMatch = clean.match(/(\d+(?:\.\d+)?)\s*kg/i) || clean.match(/peso\s*(?:de|:)?\s*(\d+(?:\.\d+)?)/i);
  if (pesoMatch) {
    data.peso = parseFloat(pesoMatch[1]);
  }

  const origenMatch = clean.match(/(?:sale|viene|desde|de|orig[en]{2})\s*(?:de|:)?\s*(\d{5})\b/);
  if (origenMatch) data.cp_origen = origenMatch[1];

  const destinoMatch = clean.match(/(?:al|a|hacia|para|dest[ino]{3})\s*(?:el|:)?\s*(\d{5})\b/);
  if (destinoMatch) data.cp_destino = destinoMatch[1];

  const allCPs = clean.match(/\b\d{5}\b/g) || [];
  if (!data.cp_origen && allCPs.length >= 2) {
    data.cp_origen = allCPs[0];
    data.cp_destino = allCPs[1];
  } else if (!data.cp_origen && allCPs.length === 1) {
    data.cp_origen = allCPs[0];
  }

  return {
    hasAnyData: Object.keys(data).length > 0,
    data,
  };
}

export function getMissingFieldMessage(missingFields) {
  const messages = {
    cp_origen: '📍 Envíame el *CP de origen* (5 dígitos)',
    cp_destino: '📍 Envíame el *CP de destino* (5 dígitos)',
    medidas: '📦 Envíame las *medidas* (ej: 60x40x30)',
    peso: '⚖️ Envíame el *peso en kg* (ej: 5 o 5kg)',
    largo: '📦 Envíame las *medidas completas* (ej: 30x20x15)',
    cel_origen: '📱 Envíame el *teléfono del remitente*',
    contenido: '📦 ¿Qué contiene el paquete?',
  };

  if (missingFields.length === 1) {
    return messages[missingFields[0]];
  }

  return `Me faltan estos datos:\n\n${missingFields.map(f => '• ' + (messages[f] || f.replace(/_/g, ' '))).join('\n')}`;
}

export function getMissingFields(data) {
  const requiredFields = [
    'cp_origen',
    'cp_destino',
    'medidas',
    'peso'
  ];

  return requiredFields.filter(f => !data[f]);
}

const SI_KEYWORDS = /^(s[ií]|yes|1|sí|si|claro|ok|dale|afirmativo)/i;
const NO_KEYWORDS = /^(no|2|nope|nel|negativo)/i;

export function parseInvoiceResponse(text) {
  const t = text.trim();
  if (SI_KEYWORDS.test(t)) return 'yes';
  if (NO_KEYWORDS.test(t)) return 'no';
  return 'ambiguous';
}

const CARRIER_MAP = {
  1: 'Estafeta Express',
  2: 'Estafeta Terrestre',
  3: 'FedEx Terrestre',
};

const CARRIER_KEYWORDS = [
  { id: 1, patterns: [/express/i, /rapido/i, /rápido/i, /urgente/i] },
  { id: 2, patterns: [/economico/i, /económico/i, /barato/i] },
  { id: 3, patterns: [/fedex/i, /federal/i] },
];

export function parseCarrierSelection(text) {
  const t = text.trim();
  const num = parseInt(t);

  if (num >= 1 && num <= 3)
    return { id: num, label: CARRIER_MAP[num] };

  if (/estafeta|esta/i.test(t) && !/express|exp|terrestre|terr/i.test(t)) {
    return { ambiguous: true };
  }

  if (/terrestre/i.test(t) && !/estafeta|fedex/i.test(t)) {
    return { ambiguous: 'terrestre' };
  }

  for (const { id, patterns } of CARRIER_KEYWORDS) {
    if (patterns.some(p => p.test(t)))
      return { id, label: CARRIER_MAP[id] };
  }

  if (/barat|económ/i.test(t)) return { id: 2, label: CARRIER_MAP[2] };
  if (/rapid|urgente/i.test(t)) return { id: 1, label: CARRIER_MAP[1] };

  return null;
}

export function parseFlexibleInput(text) {
  const t = text.replace(/\*/g, '').replace(/\r/g, '').trim();
  const norm = normalize(t);
  const data = {};

  if (isFormatoLibre(t)) {
    const libreData = parseFormatoLibre(t);
    Object.assign(data, libreData);
  }

  const medidasMatch = norm.match(/([\d.]+\s*[x×*]\s*[\d.]+\s*[x×*]\s*[\d.]+)/i);
  if (medidasMatch) {
    const medidas = medidasMatch[1].replace(/\s/g, '');
    const dims = parseDimensions(medidas);
    if (dims) {
      data.medidas = medidas;
      data.largo = dims.largo;
      data.ancho = dims.ancho;
      data.alto = dims.alto;
    }
  }

  let pesoMatch =
    norm.match(/(\d+(\.\d+)?)\s*kg/) ||
    norm.match(/pesa\s*(\d+(\.\d+)?)/) ||
    norm.match(/peso\s*:?[\s]*(\d+(\.\d+)?)/);

  if (!pesoMatch) {
    const numbers = norm.match(/\b\d+(\.\d+)?\b/g);
    if (numbers) {
      for (const num of numbers) {
        const value = parseFloat(num);
        if (value > 0 && value <= 100 && !norm.includes(`${num}x`)) {
          pesoMatch = [null, num];
          break;
        }
      }
    }
  }

  if (pesoMatch) {
    const peso = parseFloat(pesoMatch[1]);
    if (peso > 0 && peso <= 1000) data.peso = peso;
  }

  let cpOrigen = null;
  let cpDestino = null;

  const explicitOrigen =
    norm.match(/cp\s*origen\s*:?[\s]*(\d{5})/) ||
    norm.match(/origen.*?(\d{5})/);

  if (explicitOrigen) cpOrigen = explicitOrigen[1];

  const explicitDestino =
    norm.match(/cp\s*destino\s*:?[\s]*(\d{5})/) ||
    norm.match(/destino.*?(\d{5})/);

  if (explicitDestino) cpDestino = explicitDestino[1];

  const cpMatches = [...norm.matchAll(/codigo\s*postal\s*(\d{5})/g)];

  if (cpMatches.length >= 2) {
    cpOrigen = cpOrigen || cpMatches[0][1];
    cpDestino = cpDestino || cpMatches[1][1];
  }
  let match = norm.match(/de\s*(\d{5})\s*(?:a|hasta)\s*(\d{5})/);
  if (match) {
    cpOrigen = cpOrigen || match[1];
    cpDestino = cpDestino || match[2];
  }

  match = norm.match(/(?:envio|enviar|mandar).*?de\s*(\d{5}).*?(?:a|para)\s*(\d{5})/);
  if (match) {
    cpOrigen = cpOrigen || match[1];
    cpDestino = cpDestino || match[2];
  }

  match = norm.match(/\b(\d{5})\s*(?:a|->|hasta)\s*(\d{5})\b/);
  if (match) {
    cpOrigen = cpOrigen || match[1];
    cpDestino = cpDestino || match[2];
  }

  if (!cpOrigen || !cpDestino) {
    const allCPs = norm.match(/\b\d{5}\b/g);

    if (allCPs && allCPs.length >= 2) {
      if (!cpOrigen) cpOrigen = allCPs[0];
      if (!cpDestino) cpDestino = allCPs[1];
    }
  }

  if (cpOrigen) data.cp_origen = cpOrigen;
  if (cpDestino) data.cp_destino = cpDestino;

  const loose = detectLooseNumbers(text);
  const finalData = mergeFormData(data, loose);

  return finalData;
}
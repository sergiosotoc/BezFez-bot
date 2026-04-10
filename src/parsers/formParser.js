/* src/parsers/formParser.js */

function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export function normalizePhone(phone) {
  if (!phone) return null;

  // Eliminar todos los caracteres no numéricos
  let cleaned = String(phone).replace(/\D/g, '');

  // Manejar diferentes formatos de código de país
  if (cleaned.startsWith('52') && cleaned.length === 12) {
    cleaned = cleaned.slice(2);
  } else if (cleaned.startsWith('521') && cleaned.length === 13) {
    cleaned = cleaned.slice(3);
  } else if (cleaned.startsWith('1') && cleaned.length === 11) {
    // Algunos formatos pueden tener un 1 adicional
    cleaned = cleaned.slice(1);
  }

  // Validar que sea exactamente 10 dígitos
  return cleaned.length === 10 ? cleaned : null;
}

function extractTenDigitPhone(text) {
  if (!text) return null;

  const match = String(text).match(/(?:^|[^\d])((?:\d[\s\-()]*){10})(?!\d)/);
  return match ? normalizePhone(match[1]) : null;
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
  return /remitente|destinatario|receptor|recibe|envia|envia desde|envia a/i.test(norm);
}

function extractBlock(text, startPattern, endPattern) {
  const normText = normalize(text);
  const start = normText.search(startPattern);
  if (start === -1) return '';

  const afterStart = text.slice(start);
  const afterStartNorm = normText.slice(start);
  const end = afterStartNorm.slice(1).search(endPattern);

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
  const untagged = [];

  for (const line of lines) {
    const n = norm(line);
    const originalLine = line.trim();

    // Saltar encabezados de bloque (incluye variantes con tilde)
    if (/^(remitente|destinatario|receptor|envia|datos\s+de|origen|orígen|destino)/i.test(n)) {
      continue;
    }

    // 1. NOMBRE
    const nombreMatch = line.match(/^nombre\s*:?\s*(.+)/i) ||
                        line.match(/^nombre\s+(?:completo|origen|destino)?\s*:?\s*(.+)/i);
    if (nombreMatch) {
      data.nombre = nombreMatch[1].trim();
      continue;
    }

    // 2. DIRECCIÓN / CALLE
    const direccionMatch = line.match(/^(?:direccion|dirección|calle|domicilio|address)\s*:?\s*(.+)/i);
    if (direccionMatch) {
      data.calle = direccionMatch[1].trim();
      continue;
    }

    // 3. TELÉFONO
    const telMatch = line.match(/(?:cel(?:ular)?|tel(?:e?fono)?|whatsapp|movil|móvil|tel|num(?:ero)?\s+telefonico)\s*\.?\s*[:\s]*([\d\s\-+()]{7,})/i);
    const digitsOnly = line.replace(/\D/g, '');
    const isLikelyPhone = /^\d{10}$/.test(digitsOnly) && !line.match(/\d{5}/); // evitar confusión con CP

    if (telMatch || isLikelyPhone) {
      const phoneRaw = telMatch ? telMatch[1] : digitsOnly;
      const phone = normalizePhone(phoneRaw);
      if (phone) {
        data.cel = phone;
        continue;
      }
    }

    // 4. CP
    const cpMatch = line.match(/\bc\.?\s*p\.?\s*[:\s]?\s*(\d{5})\b/i) ||
                    line.match(/\bcp\s*[:\s]?\s*(\d{5})\b/i) ||
                    line.match(/\bc\.?\s*p\.?\s+(\d{5})\b/i) ||
                    line.match(/codigo\s*postal\s*:?\s*(\d{5})/i) ||
                    (/^\d{5}$/.test(line.trim()) ? [null, line.trim()] : null);

    if (cpMatch) {
      data.cp = cpMatch[1];
      continue;
    }

    // 5. COLONIA
    const colMatch = line.match(/^col(?:onia)?\.?\s*:?\s*(.+)/i);
    if (colMatch) {
      let value = colMatch[1].trim();
      if (!/\b\d{5}\b/.test(value)) {
        data.colonia = value;
      }
      continue;
    }

    // 6. CIUDAD / MUNICIPIO
    const ciudadMatch = line.match(/^(?:municipio|ciudad|city)\s*:?\s*(.+)/i);
    if (ciudadMatch) {
      data.ciudad = ciudadMatch[1].trim();
      continue;
    }

    // 7. ESTADO
    const estadoMatch = line.match(/^estado\s*:?\s*(.+)/i);
    if (estadoMatch) {
      const estado = estadoMatch[1].trim();
      if (data.ciudad) {
        data.ciudad = `${data.ciudad}, ${estado}`;
      } else {
        data.ciudad = estado;
      }
      continue;
    }

    // Si no coincide con nada, guardar para procesar después
    untagged.push(originalLine);
  }

  // ─────────────────────────────────────────
  // PROCESAR LÍNEAS SIN ETIQUETA
  // ─────────────────────────────────────────

  const posQueue = [...untagged];

  // NOMBRE
  if (!data.nombre && posQueue.length > 0) {
    const nameIdx = posQueue.findIndex(l => !/\d/.test(l) && l.length > 2 && !l.includes(','));
    if (nameIdx !== -1) {
      data.nombre = posQueue.splice(nameIdx, 1)[0];
    }
  }

  // TELÃ‰FONO sin etiqueta dentro del bloque
  if (!data.cel && posQueue.length > 0) {
    const phoneIdx = posQueue.findIndex(l => !!extractTenDigitPhone(l));
    if (phoneIdx !== -1) {
      data.cel = extractTenDigitPhone(posQueue.splice(phoneIdx, 1)[0]);
    }
  }

  // CALLE
  if (!data.calle && posQueue.length > 0) {
    const calleIdx = posQueue.findIndex(l =>
      /\d/.test(l) ||
      /retorno|avenida|av\.|calle|privada|prolongacion|boulevard|blvd|cerrada/i.test(l.toLowerCase())
    );
    if (calleIdx !== -1) {
      data.calle = posQueue.splice(calleIdx, 1)[0];
    }
  }

  // CIUDAD
  if (!data.ciudad && posQueue.length > 0) {
    const ciudadIdx = posQueue.findIndex(l =>
      l.includes(',') ||
      /puebla|morelia|cdmx|guadalajara|monterrey|mexico|méxico|durango|nuevo\s+leon|nuevo\s+león/i.test(l.toLowerCase())
    );
    if (ciudadIdx !== -1) {
      data.ciudad = posQueue.splice(ciudadIdx, 1)[0];
    }
  }

  // COLONIA
  if (!data.colonia && posQueue.length > 0) {
    const colIdx = posQueue.findIndex(l =>
      !/\d{5}/.test(l) &&
      /universal|bartolo|centro|jardines|cerritos|guadalupe|carmelita/i.test(l.toLowerCase())
    );
    if (colIdx !== -1) {
      data.colonia = posQueue.splice(colIdx, 1)[0];
    }
  }

  // Fallback genérico: si aún queda una línea de texto válida, tomarla como colonia
  if (!data.colonia && posQueue.length > 0) {
    const genericColIdx = posQueue.findIndex(l =>
      !/\d/.test(l) &&
      !l.includes(',') &&
      l.trim().length >= 3
    );
    if (genericColIdx !== -1) {
      data.colonia = posQueue.splice(genericColIdx, 1)[0];
    }
  }

  // Limpieza ciudad/estado repetidos
  if (data.ciudad) {
    const parts = data.ciudad.split(',').map(p => p.trim());
    if (parts.length >= 2) {
      const city = parts[0];
      const state = parts[1];
      if (city.toLowerCase() === state.toLowerCase() ||
          state.toLowerCase().startsWith(city.toLowerCase().substring(0, 3))) {
        data.ciudad = `${city}, ${state}`;
      }
    }
  }

  return data;
}


export function parseFormatoLibre(text) {
  const data = {};

  // Extraer bloques de origen y destino (con soporte para tildes)
  const origenBlock = extractBlock(
    text,
    /remitente|envia(?:nte)?|origen|orígen/i,
    /destinatario|destino|recibe|receptor/i
  );

  const destinoBlock = extractBlock(
    text,
    /destinatario|destino|recibe|receptor/i,
    /medidas|peso|contenido|paquete|articulos|artículos/i
  );

  // ──────────────── ORIGEN ────────────────
  if (!origenBlock) {
    // Fallback: tomar desde inicio hasta antes de "destinatario"
    const firstBlock = text.split(/destinatario|destino|recibe/i)[0];
    if (firstBlock && firstBlock.length > 10) {
      const origen = parsePersonBlock(firstBlock);
      if (origen.nombre) data.nombre_origen = origen.nombre;
      if (origen.calle) data.calle_origen = origen.calle;
      if (origen.colonia) data.colonia_origen = origen.colonia;
      if (origen.ciudad) data.ciudad_origen = origen.ciudad;
      if (origen.cp) data.cp_origen = origen.cp;
      if (origen.cel) data.cel_origen = origen.cel;
      if (!data.cel_origen) data.cel_origen = extractTenDigitPhone(firstBlock);
    }
  } else {
    const origen = parsePersonBlock(origenBlock);
    if (origen.nombre) data.nombre_origen = origen.nombre;
    if (origen.calle) data.calle_origen = origen.calle;
    if (origen.colonia) data.colonia_origen = origen.colonia;
    if (origen.ciudad) data.ciudad_origen = origen.ciudad;
    if (origen.cp) data.cp_origen = origen.cp;
    if (origen.cel) data.cel_origen = origen.cel;
    if (!data.cel_origen) data.cel_origen = extractTenDigitPhone(origenBlock);

    // Fallback: si no hay calle, buscar "Dirección:" explícita
    if (!data.calle_origen) {
      const dirMatch = origenBlock.match(/(?:direccion|dirección)\s*:?\s*(.+?)(?:\n|$)/i);
      if (dirMatch) data.calle_origen = dirMatch[1].trim();
    }
  }

  // ──────────────── DESTINO ────────────────
  if (destinoBlock) {
    const destino = parsePersonBlock(destinoBlock);
    if (destino.nombre) data.nombre_destino = destino.nombre;
    if (destino.calle) data.calle_destino = destino.calle;
    if (destino.colonia) data.colonia_destino = destino.colonia;
    if (destino.ciudad) data.ciudad_destino = destino.ciudad;
    if (destino.cp) data.cp_destino = destino.cp;
    if (destino.cel) data.cel_destino = destino.cel;
    if (!data.cel_destino) data.cel_destino = extractTenDigitPhone(destinoBlock);

    // Fallback: si no hay calle, buscar "Dirección:" explícita
    if (!data.calle_destino) {
      const dirMatch = destinoBlock.match(/(?:direccion|dirección)\s*:?\s*(.+?)(?:\n|$)/i);
      if (dirMatch) data.calle_destino = dirMatch[1].trim();
    }
  }

  // ──────────────── MEDIDAS ────────────────
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

  // ──────────────── PESO ────────────────
  const pesoPatterns = [
    /(\d+(?:\.\d+)?)\s*kg/i,
    /peso\s*:?\s*(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s*kilos?/i,
  ];
  for (const pattern of pesoPatterns) {
    const match = normalize(text).match(pattern);
    if (match) {
      const peso = parseFloat(match[1]);
      if (peso > 0 && peso <= 1000) {
        data.peso = peso;
        break;
      }
    }
  }

  // ──────────────── CONTENIDO ────────────────
  const contenidoMatch = text.match(/(?:articulos?|contenido|artículos?)\s*:?\s*(.+?)(?:\n|$)/i);
  let posibleContenido = null;

  if (contenidoMatch) {
    posibleContenido = contenidoMatch[1].trim();
  } else {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1];
    if (lastLine &&
        lastLine.length >= 3 &&
        lastLine.length <= 40 &&
        !/\d/.test(lastLine) &&
        !/[x×]/.test(lastLine)) {
      posibleContenido = lastLine;
    }
  }

  if (posibleContenido) {
    const palabrasInvalidas = [
      'destinatario','remitente','paquete','producto','articulo','artículos',
      'medidas','peso','contenido','origen','destino','cliente',
      'envio','envió','guia','guía','factura','cotizacion','cotización'
    ];
    const valido = (
      posibleContenido.length >= 3 &&
      !palabrasInvalidas.includes(posibleContenido.toLowerCase()) &&
      !/calle|colonia|ciudad|cp|c\.p|estado|municipio/i.test(posibleContenido) &&
      !/^\d+$/.test(posibleContenido.replace(/\s/g, '')) &&
      !/\d+\s*[x×]\s*\d+/.test(posibleContenido) &&
      /[a-zA-Z]/.test(posibleContenido)
    );
    if (valido) {
      data.contenido = posibleContenido;
    }
  }

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
    if (value === null || value === undefined) return;

    const clean = String(value).trim();
    if (!clean) return;

    if (key === 'cp_origen' || key === 'cp_destino') {
      if (!result[key] && /^\d{5}$/.test(clean)) {
        result[key] = clean;
      }
      return;
    }

    if (result[key]) {
      if (key.startsWith('cel_') && result[key].length === 10) return;
      if (key === 'peso' && result[key] > 0) return;
      if (key === 'medidas' && result[key].includes('x')) return;
    }

    result[key] = value;
  });

  return result;
}

export function parsePartialResponse(text) {
  const result = {};
  const cleanText = text.replace(/\*/g, '').trim();

  // 🔹 Teléfono
  const phoneMatch = cleanText.match(/(\d[\d\s\-]{8,}\d)/);
  if (phoneMatch) {
    const phone = normalizePhone(phoneMatch[1]);
    if (phone) result.cel = phone;
  }

  // 🔹 CP
  const cpMatch = cleanText.match(/\b\d{5}\b/);
  if (cpMatch) {
    result.cp = cpMatch[0];
  }

  // 🔹 Medidas
  const medidas = extractMedidas(cleanText);
  if (medidas) {
    result.medidas = medidas;
    const dims = parseDimensions(medidas);
    if (dims) {
      result.largo = dims.largo;
      result.ancho = dims.ancho;
      result.alto = dims.alto;
    }
  }

  // 🔹 Peso
  const peso = extractPeso(cleanText);
  if (peso) result.peso = peso;

  // 🔹 Texto libre (para contenido o nombre)
  if (cleanText.length > 3 && !result.medidas && !result.peso) {
    result.text = cleanText;
  }

  return result;
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
    peso: '⚖️ Envíame el *peso en kg* (ej: 5kg)',
    largo: '📦 Envíame las *medidas completas* (ej: 30x20x15)',
    cel_origen: '📱 Envíame el *teléfono de la persona que envía*',
    contenido: '📦 ¿Qué contiene el paquete?',
  };

  if (missingFields.length === 1) {
    return messages[missingFields[0]];
  }

  return `Me facilitas estos datos estos datos:\n\n${missingFields.map(f => '• ' + (messages[f] || f.replace(/_/g, ' '))).join('\n')}`;
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

  const allCPs = norm.match(/\b\d{5}\b/g);

  if (allCPs && allCPs.length === 1) {
    const cp = allCPs[0];

    if (!data.cp_origen) {
      data.cp_origen = cp;
    } else if (!data.cp_destino) {
      data.cp_destino = cp;
    }
  }

  if (allCPs && allCPs.length >= 2) {
    if (!cpOrigen) cpOrigen = allCPs[0];
    if (!cpDestino) cpDestino = allCPs[1];
  }

  if (cpOrigen) data.cp_origen = cpOrigen;
  if (cpDestino) data.cp_destino = cpDestino;

  const loose = detectLooseNumbers(text);
  const finalData = mergeFormData(data, loose);

  return finalData;

}

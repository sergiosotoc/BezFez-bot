/* src/parsers/formParser.js */

function normalize(str) {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

// ─────────────────────────────────────────────────────────
// HELPERS DE EXTRACCIÓN
// ─────────────────────────────────────────────────────────

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

function extractCP(text, side) {
  const norm = normalize(text);
  const normSide = normalize(side);

  // Patrón con etiqueta: "cp origen: 34000"
  const labeled = norm.match(
    new RegExp(`cp\\s*${normSide}\\s*:\\s*(\\d{5})`)
  );
  if (labeled) return labeled[1];

  // Línea que contiene la palabra lado + 5 dígitos
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
    /medidas?\s*(?:\(lxaxa\))?\s*:\s*([\d.]+\s*[x×*]\s*[\d.]+\s*[x×*]\s*[\d.]+)/i
  );
  if (labeled) return labeled[1].replace(/\s/g, '');

  const bare = norm.match(/\b([\d.]+\s*[x×*]\s*[\d.]+\s*[x×*]\s*[\d.]+)\b/);
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
  const match = norm.match(/peso\s*(?:\(kg\))?\s*:\s*([\d.]+)/);
  if (match) return parseFloat(match[1]);
  return null;
}

// ─────────────────────────────────────────────────────────
// PARSER DE FORMATO LIBRE (Remitente / Destinatario)
// ─────────────────────────────────────────────────────────

/**
 * Detecta si el mensaje usa el formato libre "Remitente / Destinatario"
 * en lugar del formulario etiquetado estándar.
 */
function isFormatoLibre(text) {
  const norm = normalize(text);
  return /remitente|destinatario|envia|envia desde|envia a/i.test(norm);
}

/**
 * Extrae un bloque de texto entre dos marcadores de sección.
 * Ej: entre "Remitente" y "Destinatario".
 *
 * @param {string} text
 * @param {RegExp} startPattern  - inicio del bloque
 * @param {RegExp} endPattern    - inicio del siguiente bloque (o fin del texto)
 * @returns {string}
 */
function extractBlock(text, startPattern, endPattern) {
  const start = text.search(startPattern);
  if (start === -1) return '';

  const afterStart = text.slice(start);
  const end = afterStart.slice(1).search(endPattern);

  if (end === -1) return afterStart;
  return afterStart.slice(0, end + 1);
}

/**
 * Dado un bloque de texto de una persona (remitente o destinatario),
 * extrae nombre, calle, colonia, ciudad, cp y teléfono.
 *
 * Soporta formatos como:
 *   Juan Pastrano
 *   Calle Av. Manuel Ávila Camacho #1899
 *   Col. Chapultepec Country
 *   C.p 44620
 *   Guadalajara Jalisco
 *   Cel. 3314334234
 */
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

    // Saltar la línea del encabezado de sección (Remitente / Destinatario)
    if (/^(remitente|destinatario|envia|datos\s+de)/.test(n)) continue;

    // ── CP ────────────────────────────────────────────────
    // "C.p 44620", "CP: 44620", "CP 44620", "c.p. 44620"
    const cpMatch = n.match(/\bc\.?\s*p\.?\s*[:\s]\s*(\d{5})\b/) ||
      n.match(/\bcp\s*[:\s]\s*(\d{5})\b/) ||
      line.match(/\b(\d{5})\b/);
    if (cpMatch && !data.cp) {
      data.cp = cpMatch[1];
      continue;
    }

    // ── TELÉFONO ──────────────────────────────────────────
    // "Cel. 3314334234", "Tel 656 585 7932", "Tel. +52..."
    const telMatch = n.match(/(?:cel(?:ular)?|tel(?:e?fono)?|whatsapp)\s*\.?\s*[:\s]\s*([\d\s\-+()]{7,})/);
    if (telMatch && !data.cel) {
      data.cel = telMatch[1].replace(/[\s\-()]/g, '').replace(/^\+52/, '');
      continue;
    }

    // Línea que es solo números (teléfono sin etiqueta)
    const soloNumeros = line.replace(/[\s\-()]/g, '');
    if (/^\+?[\d]{10,15}$/.test(soloNumeros) && !data.cel) {
      data.cel = soloNumeros.replace(/^\+52/, '');
      continue;
    }

    // ── COLONIA ───────────────────────────────────────────
    // "Col. Chapultepec Country", "Colonia El Barreal"
    const colMatch = line.match(/^col(?:onia)?\.?\s+(.+)/i);
    if (colMatch && !data.colonia) {
      data.colonia = colMatch[1].trim();
      continue;
    }

    // ── CALLE ─────────────────────────────────────────────
    // "Calle Av. Manuel...", "Calle: 2 de abril 1045"
    const calleMatch = line.match(/^calle\s*[:\s]\s*(.+)/i);
    if (calleMatch && !data.calle) {
      data.calle = calleMatch[1].trim();
      continue;
    }

    // Línea que contiene número de calle (#123, No. 45, num 78)
    if (!data.calle && /(#\d|no\.?\s*\d|num\.?\s*\d|\d+(,|\s|$))/i.test(line) && !data.cp) {
      data.calle = line.trim();
      continue;
    }

    // ── CIUDAD/ESTADO ─────────────────────────────────────
    // "Guadalajara Jalisco", "Cd Juárez Chihuahua", "Ciudad de México CDMX"
    // Heurística: línea sin números (ya usamos CP) con al menos 2 palabras
    if (!data.ciudad && !data.cp &&
      /[a-záéíóúüñ]{3,}/i.test(line) &&
      !/^col/i.test(line) &&
      !/^calle/i.test(line) &&
      !/(?:cel|tel|whatsapp)/i.test(n) &&
      line.split(/\s+/).length >= 2 &&
      !/\d{5}/.test(line)) {
      // Si ya tenemos nombre, esto puede ser ciudad
      if (data.nombre) {
        data.ciudad = line.trim();
        continue;
      }
    }

    // ── NOMBRE ────────────────────────────────────────────
    // Primera línea de texto puro (sin etiquetas, sin números de calle)
    if (!data.nombre &&
      /[a-záéíóúüñ]{2,}/i.test(line) &&
      !/^col/i.test(line) &&
      !/^calle/i.test(line) &&
      !/(#\d|no\.?\s*\d|num\.?\s*\d)/i.test(line) &&
      !/(?:cel|tel|whatsapp)/i.test(n) &&
      !/\b\d{5}\b/.test(line)) {
      data.nombre = line.trim();
      continue;
    }

    // ── CIUDAD (segunda pasada) ────────────────────────────
    // Líneas que quedaron sin clasificar con 2+ palabras y sin números
    if (!data.ciudad &&
      /[a-záéíóúüñ]{3,}/i.test(line) &&
      line.split(/\s+/).length >= 2 &&
      !/\d{5}/.test(line) &&
      !/(?:cel|tel)/i.test(n)) {
      data.ciudad = line.trim();
    }
  }

  return data;
}

/**
 * Parser para mensajes en formato libre: Remitente / Destinatario.
 *
 * Extrae los datos de origen y destino de un mensaje como:
 *
 *   Remitente
 *   Juan Pastrano
 *   Calle Av. Manuel Ávila Camacho #1899
 *   Col. Chapultepec Country
 *   C.p 44620
 *   Guadalajara Jalisco
 *   Cel. 3314334234
 *
 *   Destinatario
 *   Axel david Reyes Vargas
 *   ...
 *
 * @param {string} text
 * @returns {object} - Campos compatibles con el resto del sistema
 */
export function parseFormatoLibre(text) {
  const data = {};

  // ── Separar bloques ───────────────────────────────────────
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

  // ── Parsear cada bloque ───────────────────────────────────
  if (origenBlock) {
    const origen = parsePersonBlock(origenBlock);
    if (origen.nombre) data.nombre_origen = origen.nombre;
    if (origen.calle) data.calle_origen = origen.calle;
    if (origen.colonia) data.colonia_origen = origen.colonia;
    if (origen.ciudad) data.ciudad_origen = origen.ciudad;
    if (origen.cp) data.cp_origen = origen.cp;
    if (origen.cel) data.cel_origen = origen.cel;
  }

  if (destinoBlock) {
    const destino = parsePersonBlock(destinoBlock);
    if (destino.nombre) data.nombre_destino = destino.nombre;
    if (destino.calle) data.calle_destino = destino.calle;
    if (destino.colonia) data.colonia_destino = destino.colonia;
    if (destino.ciudad) data.ciudad_destino = destino.ciudad;
    if (destino.cp) data.cp_destino = destino.cp;
    if (destino.cel) data.cel_destino = destino.cel;
  }

  // ── Medidas y peso (fuera de los bloques, al final) ───────
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

  // ── Contenido ─────────────────────────────────────────────
  const contenidoMatch = text.match(/contenido\s*[:\s]\s*(.+)/i);
  if (contenidoMatch) data.contenido = contenidoMatch[1].trim();

  return data;
}

// ─────────────────────────────────────────────────────────
// PARSER PRINCIPAL DEL FORMULARIO COMPLETO
// ─────────────────────────────────────────────────────────

export function parseForm(text) {
  const t = text.replace(/\*/g, '').replace(/\r/g, '');
  const norm = normalize(t); 

  // ── Intentar primero el formato libre ─────────────────────
  if (isFormatoLibre(t)) {
    const libreData = parseFormatoLibre(t);
    if (Object.keys(libreData).length > 0) {
      const requiredFields = ['cp_origen', 'cp_destino', 'medidas', 'peso', 'largo'];
      const missing = requiredFields.filter(f => !libreData[f]);
      return { data: libreData, missing };
    }
  }

  // ── Formato estándar con etiquetas ────────────────────────
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
 
    cel_origen: extractField(t, norm,
      /cel(?:ular)?\s+origen\s*:\s*(.+)/i,
      /tel(?:e?fono)?\s+origen\s*:\s*(.+)/i),
 
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
 
    cel_destino: extractField(t, norm,
      /cel(?:ular)?\s+destino\s*:\s*(.+)/i,
      /tel(?:e?fono)?\s+destino\s*:\s*(.+)/i),
 
    medidas:   extractMedidas(t),
    peso:      extractPeso(t),
    contenido: extractField(t, norm, /contenido\s*:\s*(.+)/i),
  };

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

// ─────────────────────────────────────────────────────────
// PARSER PARCIAL
// ─────────────────────────────────────────────────────────

export function parsePartialResponse(text, fieldKeys) {
  const t = text.replace(/\*/g, '').replace(/\r/g, '').trim();
  const found = {};

  for (const field of fieldKeys) {
    switch (field) {
      case 'cp_origen': {
        const cp = t.match(/^\s*(\d{5})\s*$/) || t.match(/\b(\d{5})\b/);
        if (cp) found.cp_origen = cp[1];
        break;
      }
      case 'cp_destino': {
        const cp = t.match(/^\s*(\d{5})\s*$/) || t.match(/\b(\d{5})\b/);
        if (cp) found.cp_destino = cp[1];
        break;
      }
      case 'medidas':
      case 'largo': {
        const med = extractMedidas(t) || (() => {
          const bare = t.match(/([\d.]+\s*[x×*]\s*[\d.]+\s*[x×*]\s*[\d.]+)/i);
          return bare ? bare[1].replace(/\s/g, '') : null;
        })();
        if (med) {
          found.medidas = med;
          const dims = parseDimensions(med);
          if (dims) {
            found.largo = dims.largo;
            found.ancho = dims.ancho;
            found.alto = dims.alto;
          }
        }
        break;
      }
      case 'peso': {
        const p = normalize(t).match(/^([\d.]+)\s*(?:kg)?$/) ||
          normalize(t).match(/peso\s*(?:\(kg\))?\s*:\s*([\d.]+)/);
        if (p) {
          const value = parseFloat(p[1]);
          if (value > 0 && value <= 1000) found.peso = value;
        }
        break;
      }
    }
  }

  return found;
}

// ─────────────────────────────────────────────────────────
// MERGE
// ─────────────────────────────────────────────────────────

export function mergeFormData(prev, newData) {
  const merged = { ...(prev || {}) };
  for (const [key, value] of Object.entries(newData)) {
    if (value !== null && value !== undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

export function getMissingFields(data) {
  const requiredFields = ['cp_origen', 'cp_destino', 'medidas', 'peso', 'largo'];
  return requiredFields.filter(f => !data[f]);
}

// ─────────────────────────────────────────────────────────
// MENSAJES DE ERROR
// ─────────────────────────────────────────────────────────

export function getMissingFieldMessage(missingFields) {
  const messages = {
    cp_origen: 'Envíame el *CP de origen* (5 dígitos)',
    cp_destino: 'Envíame el *CP de destino* (5 dígitos)',
    medidas: '📦 Envíame las *medidas* (ej: 60x40x30)',
    peso: '⚖️ Envíame el *peso en kg* (ej: 5 o 5kg)',
  };

  if (missingFields.length === 1) {
    return messages[missingFields[0]];
  }

  return `Me faltan estos datos:\n\n${missingFields.map(f => '• ' + messages[f]).join('\n')}`;
}

// ─────────────────────────────────────────────────────────
// PARSERS DE OTROS ESTADOS
// ─────────────────────────────────────────────────────────

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

  // ── Intentar formato libre primero ────────────────────────
  if (isFormatoLibre(t)) {
    const libreData = parseFormatoLibre(t);
    Object.assign(data, libreData);
    return data;
  }

  // ── MEDIDAS ───────────────────────────────────────────────
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

  // ── PESO ──────────────────────────────────────────────────
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

  // ── CPs ───────────────────────────────────────────────────
  const cpOrigen = norm.match(/cp\s*origen\s*:?[\s]*(\d{5})/) ||
    norm.match(/origen.*?(\d{5})/);
  if (cpOrigen) data.cp_origen = cpOrigen[1];

  const cpDestino = norm.match(/cp\s*destino\s*:?[\s]*(\d{5})/) ||
    norm.match(/destino.*?(\d{5})/);
  if (cpDestino) data.cp_destino = cpDestino[1];

  return data;
}

export function detectUserInput(text) {
  const parsed = parseFlexibleInput(text);
  return {
    hasMedidas: !!parsed.medidas,
    hasPeso: !!parsed.peso,
    hasCpOrigen: !!parsed.cp_origen,
    hasCpDestino: !!parsed.cp_destino,
    hasAnyData: Object.keys(parsed).length > 0,
    data: parsed,
  };
}
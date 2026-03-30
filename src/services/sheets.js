/* src/services/sheets.js */
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

// ── Caché en memoria ──────────────────────────────────────
let cache = {
  tarifas: null,   // Array de filas ordenadas por peso ascendente
  lastFetched: 0,
};

// ── Autenticación JWT (igual que tu código original) ─────
function buildAuth() {
  return new JWT({
    email: config.google.clientEmail,
    key: config.google.privateKey.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

/**
 * Estructura esperada en Google Sheets (primera pestaña, sheetsByIndex[0]):
 *
 *   Col A: Peso máximo (kg)
 *   Col B: Estafeta Express    (sin IVA)
 *   Col C: Estafeta Express    (con IVA)
 *   Col D: Estafeta Terrestre  (sin IVA)
 *   Col E: Estafeta Terrestre  (con IVA)
 *   Col F: FedEx Terrestre     (sin IVA)
 *   Col G: FedEx Terrestre     (con IVA)
 */
async function fetchFromSheets() {
  const auth = buildAuth();
  const doc = new GoogleSpreadsheet(config.google.sheetId, auth);

  logger.info({ sheetId: config.google.sheetId }, 'Consultando Google Sheets');

  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  const rows = await sheet.getRows();

  const clean = (value) => {
    if (value === undefined || value === null || value === '') return 0;
    const num = Number(value.toString().replace(/[^0-9.]/g, ''));
    return Math.ceil(num);
  };

  const tarifas = rows
    .map(r => {
      const data = r._rawData;
      return {
        peso:          clean(data[0]),
        express:       clean(data[1]),
        expressIVA:    clean(data[2]),
        terrestre:     clean(data[3]),
        terrestreIVA:  clean(data[4]),
        fedex:         clean(data[5]),
        fedexIVA:      clean(data[6]),
      };
    })
    .filter(t => t.peso > 0)
    .sort((a, b) => a.peso - b.peso);

  if (tarifas.length === 0) throw new Error('La hoja de tarifas está vacía o sin filas válidas');

  logger.info({ filas: tarifas.length }, 'Tarifas cargadas desde Sheets');
  return tarifas;
}

/**
 * Obtiene las tarifas con caché de 10 minutos.
 * Fallback: si Sheets falla pero hay caché previa, la usa con advertencia.
 * Sin caché: lanza el error para que el llamador notifique al admin.
 *
 * @returns {Promise<Array>}
 */
export async function getTarifas() {
  const now = Date.now();
  const cacheValid = cache.tarifas && (now - cache.lastFetched) < config.sheetCacheTtlMs;

  if (cacheValid) return cache.tarifas;

  try {
    const tarifas = await fetchFromSheets();
    cache = { tarifas, lastFetched: now };
    return tarifas;
  } catch (err) {
    if (cache.tarifas) {
      logger.warn({ err: err.message }, 'Google Sheets no disponible — usando caché anterior');
      return cache.tarifas;
    }
    logger.error({ err: err.message }, 'Google Sheets no disponible y sin caché');
    throw err;
  }
}

/**
 * Devuelve los precios para el peso facturable dado.
 * Busca la primera fila cuyo peso >= pesoFacturable.
 * Si el peso supera todos los rangos, usa la última fila.
 *
 * @param {number} pesoFacturable
 * @param {boolean} conIVA
 * @returns {Promise<{estafeta_express, estafeta_terrestre, fedex_terrestre}>}
 */
export async function getPreciosPorPeso(pesoFacturable, conIVA) {
  const tarifas = await getTarifas();
  const fila = tarifas.find(t => t.peso >= pesoFacturable) ?? tarifas[tarifas.length - 1];

  return {
    estafeta_express:   conIVA ? fila.expressIVA   : fila.express,
    estafeta_terrestre: conIVA ? fila.terrestreIVA : fila.terrestre,
    fedex_terrestre:    conIVA ? fila.fedexIVA      : fila.fedex,
  };
}

export function invalidateRatesCache() {
  cache = { tarifas: null, lastFetched: 0 };
}

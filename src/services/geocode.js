/* src/services/geocode.js */
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

/**
 * Obtiene ciudad y estado a partir de una colonia y CP usando OpenCage.
 *
 * @param {string} query  - Colonia o dirección parcial
 * @param {string} [cp]   - Código postal (5 dígitos) para enriquecer la búsqueda
 * @returns {{ ciudad: string, estado: string, cp: string|null } | null}
 */
export async function getLocationData(query, cp = null) {
  if (!query || !config.opencage.apiKey) return null;

  // Enriquecer la query con el CP y país para mayor precisión
  const parts = [query.trim()];
  if (cp && /^\d{5}$/.test(cp) && query.trim() !== cp) parts.push(cp);
  parts.push('Mexico');
  const enrichedQuery = parts.join(', ');

  try {
    const url = [
      'https://api.opencagedata.com/geocode/v1/json',
      `?q=${encodeURIComponent(enrichedQuery)}`,
      `&key=${config.opencage.apiKey}`,
      '&countrycode=mx',
      '&limit=1',
      '&language=es',
      '&no_annotations=1',
    ].join('');

    const res = await fetch(url, { timeout: 5000 });

    // Cuota agotada
    if (res.status === 402) {
      logger.warn('OpenCage: cuota agotada — geocodificación desactivada temporalmente');
      return null;
    }

    // Rate limit
    if (res.status === 429) {
      logger.warn('OpenCage: rate limit alcanzado');
      return null;
    }

    if (!res.ok) {
      logger.warn({ status: res.status }, 'OpenCage: respuesta inesperada');
      return null;
    }

    const data = await res.json();

    if (data.status?.code !== 200) {
      logger.warn({ status: data.status }, 'OpenCage: status no OK');
      return null;
    }

    const result = data.results?.[0];
    if (!result) return null;

    // Confidence 1-10: valores bajos indican resultado poco confiable
    // Para colonias mexicanas exigimos mínimo 5
    if ((result.confidence ?? 0) < 5) {
      logger.debug({ query: enrichedQuery, confidence: result.confidence }, 'OpenCage: confianza insuficiente');
      return null;
    }

    const comp = result.components;

    const ciudad =
      comp.city ||
      comp.town ||
      comp.village ||
      comp.county ||
      comp.municipality ||
      null;

    const estado = comp.state || null;

    if (!ciudad || !estado) return null;

    return {
      ciudad,
      estado,
      cp: comp.postcode || null,
    };

  } catch (err) {
    logger.warn({ err: err.message, query: enrichedQuery }, 'Error en OpenCage geocode');
    return null;
  }
}

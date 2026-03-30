/* src/services/storage.js */
import { supabase } from './supabase.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

const BUCKET = 'comprobantes';

/**
 * Sube un buffer de archivo a Supabase Storage con reintentos exponenciales.
 *
 * Retries: 3 intentos con backoff 1s → 2s → 4s antes de lanzar el error.
 *
 * @param {Buffer} buffer     - Contenido del archivo
 * @param {string} folio      - PED-XXXXXX (usado en el path)
 * @param {string} mimeType   - 'image/jpeg', 'application/pdf', etc.
 * @returns {Promise<string>} - URL pública del archivo subido
 */
export async function uploadComprobante(buffer, folio, mimeType) {
  const ext      = mimeTypeToExt(mimeType);
  const path     = `${folio}/${Date.now()}.${ext}`;
  const maxRetries = config.uploadMaxRetries;

  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const { error: uploadError } = await supabase.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: mimeType, upsert: false });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from(BUCKET)
        .getPublicUrl(path);

      logger.info({ folio, path, attempt }, 'Comprobante subido correctamente');
      return urlData.publicUrl;

    } catch (err) {
      lastError = err;
      logger.warn({ folio, attempt, maxRetries, err: err.message }, 'Error subiendo comprobante, reintentando...');

      if (attempt < maxRetries) {
        const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        await sleep(backoffMs);
      }
    }
  }

  logger.error({ folio, err: lastError?.message }, 'Falló la subida del comprobante después de todos los reintentos');
  throw lastError;
}

/**
 * Asegura que el bucket exista (ejecutar al inicializar el bot).
 * Supabase Storage no crea buckets automáticamente.
 */
export async function ensureBucketExists() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;

  const exists = buckets.some(b => b.name === BUCKET);
  if (exists) return;

  const { error: createError } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 10 * 1024 * 1024, // 10 MB
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  });

  if (createError) throw createError;
  logger.info({ bucket: BUCKET }, 'Bucket creado');
}

// ── Helpers ───────────────────────────────────────────────

function mimeTypeToExt(mimeType) {
  const map = {
    'image/jpeg':      'jpg',
    'image/jpg':       'jpg',
    'image/png':       'png',
    'image/webp':      'webp',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || 'bin';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

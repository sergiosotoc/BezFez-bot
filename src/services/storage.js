/* src/services/storage.js */
import { supabase } from './supabase.js';
import { config } from '../config/index.js';
import { logger } from '../config/logger.js';

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

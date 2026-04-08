/* src/services/storage.js */
import { supabase } from './supabase.js';
import { logger } from '../config/logger.js';

const BUCKET = 'bot-files'; 

export async function ensureBucketExists() {
  const { data: buckets, error } = await supabase.storage.listBuckets();
  if (error) throw error;

  const exists = buckets.some(b => b.name === BUCKET);
  if (exists) return;

  const { error: createError } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: 10 * 1024 * 1024, 
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'],
  });

  if (createError) throw createError;
  logger.info({ bucket: BUCKET }, 'Bucket creado');
}
/* src/bot/auth.js */

import { supabase } from '../services/supabase.js';
import { logger } from '../config/logger.js';
import fs from 'fs/promises';
import path from 'path';

const AUTH_DIR = './auth_info';
const BUCKET = 'auth-sessions';
const SESSION_KEY = 'baileys-session';

export async function ensureAuthBucket() {
  const { data: buckets } = await supabase.storage.listBuckets();
  const exists = buckets?.some(b => b.name === BUCKET);
  if (exists) return;

  await supabase.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: 5 * 1024 * 1024,
  });
  logger.info({ bucket: BUCKET }, 'Bucket de auth creado');
}

export async function downloadAuthFromSupabase() {
  try {
    const { data: files, error } = await supabase.storage
      .from(BUCKET)
      .list(SESSION_KEY);

    if (error || !files || files.length === 0) {
      logger.info('No hay sesión guardada en Supabase — se generará QR');
      return false;
    }

    await fs.mkdir(AUTH_DIR, { recursive: true });

    for (const file of files) {
      const { data, error: dlErr } = await supabase.storage
        .from(BUCKET)
        .download(`${SESSION_KEY}/${file.name}`);

      if (dlErr) continue;

      const buffer = Buffer.from(await data.arrayBuffer());
      await fs.writeFile(path.join(AUTH_DIR, file.name), buffer);
    }

    logger.info({ files: files.length }, 'Sesión de WhatsApp restaurada desde Supabase');
    return true;
  } catch (err) {
    logger.warn({ err: err.message }, 'Error descargando auth desde Supabase');
    return false;
  }
}

export async function uploadAuthToSupabase() {
  try {
    const files = await fs.readdir(AUTH_DIR);

    for (const filename of files) {
      const filepath = path.join(AUTH_DIR, filename);
      const buffer = await fs.readFile(filepath);
      const contentType = filename.endsWith('.json')
        ? 'application/json'
        : 'application/octet-stream';

      await supabase.storage
        .from(BUCKET)
        .upload(`${SESSION_KEY}/${filename}`, buffer, {
          contentType,
          upsert: true,
        });
    }

    logger.info({ files: files.length }, 'Sesión de WhatsApp guardada en Supabase');
  } catch (err) {
    logger.warn({ err: err.message }, 'Error subiendo auth a Supabase');
  }
}

export async function resetAuthStorage() {
  try {
    const { data: files } = await supabase.storage
      .from(BUCKET)
      .list(SESSION_KEY);

    if (files?.length) {
      await supabase.storage
        .from(BUCKET)
        .remove(files.map(file => `${SESSION_KEY}/${file.name}`));
    }

    await fs.rm(AUTH_DIR, { recursive: true, force: true });
    logger.warn('Sesion de WhatsApp eliminada por comando admin');
    return true;
  } catch (err) {
    logger.error({ err: err.message }, 'Error reseteando auth');
    return false;
  }
}

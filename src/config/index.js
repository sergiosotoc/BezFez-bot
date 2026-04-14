/* src/config/idex.js */
import dotenv from 'dotenv';
dotenv.config();

function required(key) {
  const val = process.env[key];
  if (!val) throw new Error(`Variable de entorno requerida no definida: ${key}`);
  return val;
}

export const config = {
  supabase: {
    url: required('SUPABASE_URL'),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  },
  opencage: {
    apiKey: process.env.OPENCAGE_API_KEY,
  },
  admin: {
    phone: required('ADMIN_PHONE'),
    jid: `${required('ADMIN_PHONE')}@s.whatsapp.net`,
  },
  iva:               parseFloat(process.env.IVA_RATE || '0.16'),
  oversizeThreshold: 100,
  oversizeCharge:    175,
  pauseDurationMs:   60 * 60 * 1000,
  reminderOffsetMs:  50 * 60 * 1000,
  processedMsgTtlMs:  5 * 60 * 1000,
  sheetCacheTtlMs:   10 * 60 * 1000,
  uploadMaxRetries:  3,
  logLevel:          process.env.LOG_LEVEL || 'info',
};

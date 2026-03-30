/* src/config/idex.js */
import 'dotenv/config';

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
  google: {
    sheetId:     required('SHEET_ID'),
    clientEmail: required('GOOGLE_CLIENT_EMAIL'),
    privateKey:  required('GOOGLE_PRIVATE_KEY'),
  },
  admin: {
    phone: required('ADMIN_PHONE'),
    jid: `${required('ADMIN_PHONE')}@s.whatsapp.net`,
  },
  bank: {
    name:    process.env.BANK_NAME    || 'Tu Banco',
    account: process.env.BANK_ACCOUNT || '123456789',
    clabe:   process.env.BANK_CLABE   || '012345678901234567',
    holder:  process.env.BANK_HOLDER  || 'Tu Nombre',
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

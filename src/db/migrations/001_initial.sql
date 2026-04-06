-- ============================================================
-- BazFez Bot — Schema inicial
-- Ejecutar en el SQL Editor de Supabase
-- ============================================================

-- Enum de estados FSM
CREATE TYPE fsm_state AS ENUM (
  'IDLE',
  'AWAITING_FORMAT',
  'PARSING_DATA',
  'AWAITING_INVOICE',
  'AWAITING_SELECTION',
  'AWAITING_ADDRESS',
  'AWAITING_PAYMENT',
  'PAUSED'
);

-- ── sessions ─────────────────────────────────────────────
-- Una fila por chat activo (chat_id = JID de WhatsApp)
CREATE TABLE IF NOT EXISTS sessions (
  chat_id           TEXT PRIMARY KEY,
  state             fsm_state NOT NULL DEFAULT 'IDLE',
  form_data         JSONB,
  selected_carrier  TEXT,
  invoice_required  BOOLEAN,
  billable_weight   NUMERIC(8,2),
  oversize_charge   NUMERIC(8,2) DEFAULT 0,
  total_amount      NUMERIC(10,2),
  pending_selection TEXT,
  paused_at         TIMESTAMPTZ,
  pause_expires_at  TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── orders ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  folio             TEXT PRIMARY KEY,
  chat_id           TEXT NOT NULL REFERENCES sessions(chat_id),
  carrier           TEXT NOT NULL,
  total_amount      NUMERIC(10,2) NOT NULL,
  invoice_required  BOOLEAN NOT NULL DEFAULT FALSE,
  billable_weight   NUMERIC(8,2),
  oversize_charge   NUMERIC(8,2) DEFAULT 0,
  form_snapshot     JSONB,
  status            TEXT NOT NULL DEFAULT 'PENDING_PAYMENT',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── file_uploads ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_uploads (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio        TEXT NOT NULL REFERENCES orders(folio),
  storage_url  TEXT NOT NULL,
  mime_type    TEXT,
  file_size    INTEGER,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── admin_pauses ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_pauses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id         TEXT NOT NULL REFERENCES sessions(chat_id),
  extended_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  new_expires_at  TIMESTAMPTZ NOT NULL
);

-- ── processed_messages ───────────────────────────────────
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   TEXT PRIMARY KEY,
  chat_id      TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_processed_msgs_at
  ON processed_messages (processed_at);

-- ── Trigger: updated_at automático ───────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS (Row Level Security) ──────────────────────────────
-- El service_role_key del backend ignora RLS por defecto
ALTER TABLE sessions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders             ENABLE ROW LEVEL SECURITY;
ALTER TABLE file_uploads       ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_pauses       ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_messages ENABLE ROW LEVEL SECURITY;
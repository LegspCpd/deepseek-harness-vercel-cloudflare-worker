-- ============================================================================
-- DeepSeek Harness Serverless — Neon PostgreSQL schema (v2, per-user)
--
-- Run this script in the Neon SQL Editor (or via psql) once. Idempotent:
-- every statement uses IF NOT EXISTS, so re-running is safe.
--
-- v2 change: introduces the `users` table and adds `user_id` ownership to
-- `sessions` and `plugin_configs`. Every repository query filters by
-- user_id, which is the enforcement point for BOLA/IDOR protection.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users — each user has a scrypt-hashed API key (plaintext never stored)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  api_key_id   TEXT NOT NULL UNIQUE,
  api_key_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS users_api_key_id_idx ON users (api_key_id);

-- ---------------------------------------------------------------------------
-- sessions — owned by exactly one user
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title      TEXT NOT NULL DEFAULT 'New session',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  meta       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sessions_user_created_idx
  ON sessions (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- messages — ownership flows through the owning session
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content    JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_session_created_idx
  ON messages (session_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- plugin_configs — per-user plugin configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plugin_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL,
  config      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS plugin_configs_user_name_idx
  ON plugin_configs (user_id, plugin_name);

-- ---------------------------------------------------------------------------
-- Trigger: bump sessions.updated_at whenever a message lands in the session
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_session() RETURNS trigger AS $$
BEGIN
  UPDATE sessions SET updated_at = now() WHERE id = NEW.session_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS messages_touch_session ON messages;
CREATE TRIGGER messages_touch_session
  AFTER INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION touch_session();

-- =============================================================================
-- MeterGate — initial schema (Phase 2)
-- =============================================================================
-- This file runs ONCE, on the very first boot of the Postgres container,
-- before any client connects. Postgres's init process executes every .sql
-- file in /docker-entrypoint-initdb.d/ in alphabetical order.
--
-- If you later change this file and want it re-run:
--   docker compose down -v    ← deletes the postgres_data volume
--   docker compose up
-- The -v flag is important: it wipes the volume. Without it, the schema
-- won't be recreated because Postgres only inits an empty data directory.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- -----------------------------------------------------------------------------
-- tenants
-- -----------------------------------------------------------------------------
-- A tenant is an organization / customer using MeterGate.
-- For M2 we don't have a full auth system, so we'll seed one tenant.
-- -----------------------------------------------------------------------------
CREATE TABLE tenants (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL DEFAULT 'free',
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- api_keys
-- -----------------------------------------------------------------------------
-- We store ONLY the SHA-256 hash of the key, never the plaintext.
-- `prefix` is the display form ("mg_live_a81f"), safe to show.
-- -----------------------------------------------------------------------------
CREATE TABLE api_keys (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  prefix      TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ
);

CREATE INDEX idx_api_keys_hash     ON api_keys (key_hash);
CREATE INDEX idx_api_keys_tenant   ON api_keys (tenant_id);

-- -----------------------------------------------------------------------------
-- Seed data
-- -----------------------------------------------------------------------------
-- One demo tenant so we can test the flow immediately.
-- -----------------------------------------------------------------------------
INSERT INTO tenants (id, name, plan, status) VALUES
  ('tenant_acme', 'Acme Technologies', 'pro',  'active'),
  ('tenant_globex', 'Globex Corp',     'free', 'active');

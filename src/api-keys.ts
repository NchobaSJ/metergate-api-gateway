/*
 * api-keys.ts
 *
 * API key management backed by PostgreSQL.
 *
 * Public API is identical to the in-memory version — only the storage
 * changed. This is a common refactor pattern: keep the contract,
 * swap the implementation.
 *
 * SECURITY INVARIANTS (from MeterGate FR-002 / FR-003):
 *   - The plaintext key is NEVER stored. Only its SHA-256 hash.
 *   - The plaintext is returned EXACTLY ONCE at creation.
 *   - The prefix ("mg_live_a81f") is stored for display only.
 *   - Revocation is a soft delete: `revoked_at` is set, record is kept.
 *   - Expiration is optional; null means "no expiration".
 *
 * NOT IN THIS FILE (yet):
 *   - Redis caching (that's M3)
 *   - Rate limiting (M4)
 *   - Quotas (M5)
 */

import crypto from 'node:crypto';
import { pool } from './db.js';

/*
 * ---------------------------------------------------------------------------
 * Types (unchanged from in-memory version)
 * ---------------------------------------------------------------------------
 */

export interface ApiKeyRecord {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
}

export interface ApiKeyCreated {
  plaintext: string;
  record: ApiKeyRecord;
}

export interface ApiKeyPublic {
  id: string;
  tenant_id: string;
  name: string;
  prefix: string;
  created_at: string;
  revoked_at: string | null;
  expires_at: string | null;
}

/*
 * ---------------------------------------------------------------------------
 * Helpers (unchanged)
 * ---------------------------------------------------------------------------
 */

function createKeyId(): string {
  return `key_${crypto.randomUUID()}`;
}

function generatePlaintextKey(env: 'live' | 'test' = 'live'): string {
  const secret = crypto.randomBytes(32).toString('hex');
  return `mg_${env}_${secret}`;
}

function hashKey(plaintext: string): string {
  return crypto
    .createHash('sha256')
    .update(plaintext, 'utf8')
    .digest('hex');
}

function extractPrefix(plaintext: string): string {
  const parts = plaintext.split('_');
  if (parts.length < 3) return plaintext.slice(0, 12);
  const [product, env, secret] = parts;
  return `${product}_${env}_${secret.slice(0, 4)}`;
}

/*
 * Convert a DB row into an ApiKeyRecord with ISO timestamps.
 * pg returns Date objects for TIMESTAMPTZ columns; the rest of the
 * application speaks ISO strings.
 */
function rowToRecord(row: any): ApiKeyRecord {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    prefix: row.prefix,
    key_hash: row.key_hash,
    created_at: row.created_at.toISOString(),
    revoked_at: row.revoked_at ? row.revoked_at.toISOString() : null,
    expires_at: row.expires_at ? row.expires_at.toISOString() : null,
  };
}

function recordToPublic(record: ApiKeyRecord): ApiKeyPublic {
  return {
    id: record.id,
    tenant_id: record.tenant_id,
    name: record.name,
    prefix: record.prefix,
    created_at: record.created_at,
    revoked_at: record.revoked_at,
    expires_at: record.expires_at,
  };
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

export async function createApiKey(
  tenantId: string,
  name: string,
  options: { env?: 'live' | 'test'; expiresAt?: string | null } = {}
): Promise<ApiKeyCreated> {
  const env = options.env ?? 'live';
  const plaintext = generatePlaintextKey(env);
  const key_hash = hashKey(plaintext);
  const prefix = extractPrefix(plaintext);
  const id = createKeyId();

  const result = await pool.query(
    `INSERT INTO api_keys
       (id, tenant_id, name, prefix, key_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [id, tenantId, name, prefix, key_hash, options.expiresAt ?? null]
  );

  return {
    plaintext,
    record: rowToRecord(result.rows[0]),
  };
}

/*
 * Validate a plaintext API key.
 *
 * Reject if:
 *   - hash not found
 *   - revoked_at is set
 *   - expires_at is in the past
 *
 * All three return null (indistinguishable to the client).
 */
export async function validateApiKey(
  plaintext: string
): Promise<ApiKeyRecord | null> {
  const hash = hashKey(plaintext);

  const result = await pool.query(
    `SELECT * FROM api_keys
     WHERE key_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now())
     LIMIT 1`,
    [hash]
  );

  if (result.rows.length === 0) return null;
  return rowToRecord(result.rows[0]);
}

export async function revokeApiKey(id: string): Promise<boolean> {
  const result = await pool.query(
    `UPDATE api_keys
     SET revoked_at = now()
     WHERE id = $1 AND revoked_at IS NULL`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listApiKeys(
  tenantId?: string
): Promise<ApiKeyPublic[]> {
  const result = tenantId
    ? await pool.query(
        `SELECT * FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
        [tenantId]
      )
    : await pool.query(`SELECT * FROM api_keys ORDER BY created_at DESC`);

  return result.rows.map((row) => recordToPublic(rowToRecord(row)));
}

export async function getApiKey(id: string): Promise<ApiKeyPublic | null> {
  const result = await pool.query(`SELECT * FROM api_keys WHERE id = $1`, [id]);
  if (result.rows.length === 0) return null;
  return recordToPublic(rowToRecord(result.rows[0]));
}
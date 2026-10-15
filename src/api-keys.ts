/*
 * api-keys.ts
 *
 * In-memory API key store for MeterGate (M2).
 *
 * This module is responsible for:
 *   1. Generating cryptographically random API keys
 *   2. Hashing them with SHA-256 before storing
 *   3. Validating incoming keys at request time
 *   4. Revoking keys
 *   5. Listing keys for the admin endpoints
 *
 * DESIGN NOTES (from MeterGate FR-002 / FR-003):
 *
 *   - The full plaintext key is NEVER stored. Only its SHA-256 hash.
 *   - A short "prefix" (e.g. "mg_live_a81f") IS stored, for display,
 *     so a tenant can identify which key is which in the dashboard.
 *   - The plaintext key is shown to the caller EXACTLY ONCE, at creation.
 *   - Expiration is supported but optional.
 *   - Revocation is a soft delete (we keep the record with revoked_at set).
 *
 * Why SHA-256 and not bcrypt/scrypt/argon2?
 *
 *   Those are password hashing functions designed for LOW-ENTROPY secrets
 *   (user passwords, which humans choose and which can be brute-forced).
 *   An API key like mg_live_<32 random bytes> has ~256 bits of entropy.
 *   Brute-forcing it is infeasible regardless of hashing speed. So we
 *   want the FASTEST good hash — SHA-256 — for O(1) lookup.
 *
 * This file is intentionally self-contained with no external deps
 * beyond Node's built-in crypto. In Phase 2, this module will be
 * backed by PostgreSQL + Prisma instead of a Map.
 */

import crypto from 'node:crypto';

/*
 * ---------------------------------------------------------------------------
 * Types
 * ---------------------------------------------------------------------------
 */

/*
 * The internal representation of an API key.
 *
 * Notice what is NOT here: the plaintext. Ever.
 */
export interface ApiKeyRecord {
  id: string;                  // internal id, e.g. "key_01HXYZ..."
  tenant_id: string;           // owner (e.g. "tenant_acme")
  name: string;                // human label, e.g. "Production API"
  prefix: string;              // display value, e.g. "mg_live_a81f"
  key_hash: string;            // SHA-256 hex of the full plaintext
  created_at: string;          // ISO 8601
  revoked_at: string | null;   // null if active
  expires_at: string | null;   // null if no expiration
}

/*
 * What we return to the caller at creation time.
 *
 * `plaintext` is shown ONCE and never again.
 */
export interface ApiKeyCreated {
  plaintext: string;
  record: ApiKeyRecord;
}

/*
 * What we return from list endpoints.
 *
 * Deliberately omits key_hash and plaintext. The dashboard only
 * needs to display the prefix + metadata.
 */
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
 * In-memory storage
 *
 * Two indexes so we can look up by either:
 *   - hash  (fast path, at authentication time)
 *   - id    (management path, e.g. DELETE /admin/api-keys/:id)
 * ---------------------------------------------------------------------------
 */

const keysByHash = new Map<string, ApiKeyRecord>();
const keysById = new Map<string, ApiKeyRecord>();

/*
 * ---------------------------------------------------------------------------
 * Helpers
 * ---------------------------------------------------------------------------
 */

/*
 * Generate an internal id for a key record.
 * Not the same as the API key itself — just an identifier for the dashboard.
 */
function createKeyId(): string {
  return `key_${crypto.randomUUID()}`;
}

/*
 * Generate a new random API key.
 *
 * Format:   mg_<env>_<64 hex chars>
 * Example:  mg_live_a81f3c92e4d5b6789abcdef0123456789abcdef0123456789abcdef01234567
 *
 * Why 32 bytes (64 hex chars)?
 *   - 256 bits of entropy. Brute force is not feasible.
 *   - Same order of magnitude as Stripe's keys and GitHub PATs.
 *
 * Why the "live" / "test" split?
 *   - Industry convention (Stripe, GitHub).
 *   - Lets the same codebase serve both production and sandbox keys
 *     without mixing them up in logs or dashboards.
 */
function generatePlaintextKey(env: 'live' | 'test' = 'live'): string {
  const secret = crypto.randomBytes(32).toString('hex');
  return `mg_${env}_${secret}`;
}

/*
 * SHA-256 of the plaintext, hex encoded.
 *
 * Deterministic: same input always gives the same hash, which is
 * exactly what we need for O(1) Map/DB lookup.
 */
function hashKey(plaintext: string): string {
  return crypto
    .createHash('sha256')
    .update(plaintext, 'utf8')
    .digest('hex');
}

/*
 * Extract the display prefix from a plaintext key.
 *
 * "mg_live_a81f3c92e4..." → "mg_live_a81f"
 *
 * We keep the environment tag and 4 hex chars of the random part.
 * Enough to identify a key in a list, not enough to be useful if leaked.
 */
function extractPrefix(plaintext: string): string {
  // Split on "_" but keep the parts we care about.
  // "mg_live_a81f3c..." → ["mg", "live", "a81f3c..."]
  const parts = plaintext.split('_');
  if (parts.length < 3) {
    // Defensive: should never happen with our own generator.
    return plaintext.slice(0, 12);
  }
  const [product, env, secret] = parts;
  return `${product}_${env}_${secret.slice(0, 4)}`;
}

/*
 * ---------------------------------------------------------------------------
 * Public API
 * ---------------------------------------------------------------------------
 */

/*
 * Create a new API key for a tenant.
 *
 * Returns:
 *   - the plaintext (show ONCE to the caller)
 *   - the record (safe to store and display)
 */
export function createApiKey(
  tenantId: string,
  name: string,
  options: { env?: 'live' | 'test'; expiresAt?: string | null } = {}
): ApiKeyCreated {
  const env = options.env ?? 'live';
  const plaintext = generatePlaintextKey(env);
  const key_hash = hashKey(plaintext);
  const prefix = extractPrefix(plaintext);

  const record: ApiKeyRecord = {
    id: createKeyId(),
    tenant_id: tenantId,
    name,
    prefix,
    key_hash,
    created_at: new Date().toISOString(),
    revoked_at: null,
    expires_at: options.expiresAt ?? null,
  };

  keysByHash.set(key_hash, record);
  keysById.set(record.id, record);

  return { plaintext, record };
}

/*
 * Look up an API key by its plaintext.
 *
 * Returns the record if the key is:
 *   - present (hash matches something we stored)
 *   - not revoked
 *   - not expired
 *
 * Returns null otherwise.
 *
 * The caller does not get to know WHICH of those failed. From the client's
 * perspective all invalid keys look the same → 401 invalid_api_key.
 * That avoids leaking information about key lifecycle.
 */
export function validateApiKey(plaintext: string): ApiKeyRecord | null {
  const hash = hashKey(plaintext);
  const record = keysByHash.get(hash);

  if (!record) {
    return null;
  }

  if (record.revoked_at !== null) {
    return null;
  }

  if (record.expires_at !== null) {
    const expiresAt = Date.parse(record.expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
      return null;
    }
  }

  return record;
}

/*
 * Revoke a key by its internal id.
 *
 * Returns true if the key existed and was active (or already revoked),
 * false if no such key exists.
 *
 * Idempotent: calling twice is fine.
 */
export function revokeApiKey(id: string): boolean {
  const record = keysById.get(id);
  if (!record) {
    return false;
  }
  if (record.revoked_at === null) {
    record.revoked_at = new Date().toISOString();
  }
  return true;
}

/*
 * List keys, optionally filtered by tenant.
 *
 * Returns safe/public view — no hash, no plaintext.
 */
export function listApiKeys(tenantId?: string): ApiKeyPublic[] {
  const all = Array.from(keysById.values());

  const filtered = tenantId
    ? all.filter((r) => r.tenant_id === tenantId)
    : all;

  return filtered.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    name: r.name,
    prefix: r.prefix,
    created_at: r.created_at,
    revoked_at: r.revoked_at,
    expires_at: r.expires_at,
  }));
}

/*
 * Get a single key by id (public view).
 * Handy for admin endpoints and tests.
 */
export function getApiKey(id: string): ApiKeyPublic | null {
  const record = keysById.get(id);
  if (!record) return null;
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
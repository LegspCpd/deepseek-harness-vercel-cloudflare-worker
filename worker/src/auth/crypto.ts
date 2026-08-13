/**
 * API-key hashing with Node's scrypt (available under Workers' nodejs_compat).
 *
 * The plaintext API key is shown to the user exactly once at creation and is
 * never stored; only the salted scrypt hash survives in the database. This
 * keeps the credential safe even if the DB leaks.
 * @module serverless-worker/auth/crypto
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Length of the scrypt salt in bytes. */
const SALT_BYTES = 16
/** scrypt key length in bytes. */
const KEY_BYTES = 32
/** Length of the random key-id, in bytes, hex-encoded to 16 chars. */
const KEY_ID_BYTES = 8
/** Length of the random secret, in bytes, hex-encoded to 32 chars. */
const SECRET_BYTES = 16

/** A freshly generated API key plus its public id and secret hash. */
export interface ApiKeyMaterial {
  /** The full plaintext key presented by clients: `dsk_<keyId>_<secret>`. */
  readonly apiKey: string
  /** The public key id, stored plaintext for indexed lookup. */
  readonly apiKeyId: string
  /** The scrypt `salt:hash` of the secret, stored in the DB. */
  readonly apiKeyHash: string
}

/**
 * Generate a new API key. The plaintext is returned exactly once; callers must
 * show it to the user immediately and never log it.
 */
export function generateApiKey(): ApiKeyMaterial {
  const keyId = randomBytes(KEY_ID_BYTES).toString('hex')
  const secret = randomBytes(SECRET_BYTES).toString('hex')
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(secret, salt, KEY_BYTES)
  return {
    apiKey: `dsk_${keyId}_${secret}`,
    apiKeyId: keyId,
    apiKeyHash: `${salt.toString('hex')}:${hash.toString('hex')}`,
  }
}

/** A parsed API key split into its public id and secret. */
export interface ParsedApiKey {
  readonly keyId: string
  readonly secret: string
}

/**
 * Split a `dsk_<keyId>_<secret>` API key into parts. Returns `undefined` when
 * the format is invalid, so callers can reject it early.
 */
export function parseApiKey(apiKey: string): ParsedApiKey | undefined {
  const match = /^dsk_([a-f0-9]{16})_([a-f0-9]{32})$/.exec(apiKey)
  if (match === null) return undefined
  return { keyId: match[1] as string, secret: match[2] as string }
}

/**
 * Hash a secret into a `salt:hash` string with a fresh random salt.
 * @param secret - The plaintext secret to hash.
 * @returns `saltHex:hashHex`.
 */
export function hashSecret(secret: string): string {
  const salt = randomBytes(SALT_BYTES)
  const hash = scryptSync(secret, salt, KEY_BYTES)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

/**
 * Verify a plaintext secret against a stored `salt:hash` string.
 * @param secret - The presented plaintext secret.
 * @param stored - The `salt:hash` value from the database.
 * @returns Whether the secret matches.
 */
export function verifySecret(secret: string, stored: string): boolean {
  const separator = stored.indexOf(':')
  if (separator < 0) return false
  const saltHex = stored.slice(0, separator)
  const hashHex = stored.slice(separator + 1)
  if (saltHex.length === 0 || hashHex.length === 0) return false
  let salt: Buffer
  let expected: Buffer
  try {
    salt = Buffer.from(saltHex, 'hex')
    expected = Buffer.from(hashHex, 'hex')
  } catch {
    return false
  }
  if (salt.length === 0 || expected.length === 0) return false
  const actual = scryptSync(secret, salt, KEY_BYTES)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

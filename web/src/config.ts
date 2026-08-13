/**
 * Frontend runtime configuration.
 *
 * The only public value baked into the bundle is the Worker URL
 * (`NEXT_PUBLIC_WORKER_URL`). The user's API key is stored in localStorage and
 * sent as a Bearer token; it never lands in code or server logs.
 * @module vercel-ui/config
 */

export interface RuntimeConfig {
  readonly workerUrl: string
}

const getWorkerUrl = (): string => {
  const fromEnv = (import.meta.env.NEXT_PUBLIC_WORKER_URL as string | undefined) ?? ''
  if (fromEnv.length > 0) return fromEnv.replace(/\/+$/, '')
  // Local dev fallback to wrangler dev default.
  return 'http://localhost:8787'
}

export const runtimeConfig: RuntimeConfig = {
  workerUrl: getWorkerUrl(),
}

/** localStorage key for the user's API key. */
const API_KEY_STORAGE = 'dsh.apiKey'
/** localStorage key for the user's name. */
const USER_NAME_STORAGE = 'dsh.userName'

/** Read the stored API key, if any. */
export function loadApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? ''
  } catch {
    return ''
  }
}

/** Persist the API key. */
export function saveApiKey(apiKey: string): void {
  try {
    localStorage.setItem(API_KEY_STORAGE, apiKey)
  } catch {
    // Storage may be unavailable (private mode); degrade to in-memory.
  }
}

/** Clear the stored API key. */
export function clearApiKey(): void {
  try {
    localStorage.removeItem(API_KEY_STORAGE)
  } catch {
    // noop
  }
}

/** Read the stored user name, if any. */
export function loadUserName(): string {
  try {
    return localStorage.getItem(USER_NAME_STORAGE) ?? ''
  } catch {
    return ''
  }
}

/** Persist the user name. */
export function saveUserName(name: string): void {
  try {
    localStorage.setItem(USER_NAME_STORAGE, name)
  } catch {
    // noop
  }
}

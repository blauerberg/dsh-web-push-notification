import type { PresenceReport } from './presence.ts'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_SUPPRESSION_SETTINGS,
  MAX_IDLE_MINUTES,
  MIN_IDLE_MINUTES,
  type NotificationBodyMode,
  type NotificationPreferences,
  type PushSubscriptionRecord,
  type PushStoreState,
  type SuppressionSettings,
  type VapidKeys,
} from './types.ts'

const BASE64URL = /^[A-Za-z0-9_-]+$/
const MAX_ENDPOINT_LENGTH = 2048
const MAX_KEY_LENGTH = 512

export function validateSubscription(value: unknown): PushSubscriptionRecord {
  if (!isRecord(value)) throw new Error('subscription must be an object')
  const endpoint = parseEndpoint(value.endpoint, 'subscription endpoint is invalid')
  const keys = value.keys
  if (!isRecord(keys)) throw new Error('subscription keys are missing')
  const p256dh = validBase64Url(keys.p256dh, 'p256dh')
  const auth = validBase64Url(keys.auth, 'auth')
  const expirationTime = value.expirationTime
  if (
    expirationTime !== undefined &&
    expirationTime !== null &&
    (typeof expirationTime !== 'number' || !Number.isFinite(expirationTime) || expirationTime < 0)
  ) {
    throw new Error('subscription expirationTime is invalid')
  }
  const preferences = validatePreferences(value.preferences)
  return {
    endpoint,
    expirationTime: expirationTime === undefined ? null : expirationTime,
    keys: { p256dh, auth },
    preferences,
  }
}

/**
 * The endpoint a renewal replaces, as named by the caller.
 *
 * It is only ever a lookup key for the record it supersedes, never an address
 * this process dials, so it is checked for shape rather than for host safety:
 * a record stored before the host policy existed must still be renewable.
 */
export function validatePreviousEndpoint(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  const endpoint = value.previousEndpoint
  // JSON has two spellings for "absent", the same pair expirationTime accepts.
  if (endpoint === undefined || endpoint === null) return undefined
  if (typeof endpoint !== 'string' || endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) {
    throw new Error('previous endpoint must be a non-empty string')
  }
  return endpoint
}

/**
 * Whether a subscription request carried its own notification preferences.
 *
 * `validateSubscription` answers that omission with the defaults, which is right
 * for a first registration and wrong for a renewal: a device that chose "summary
 * only" would be switched back to full bodies by a rotation it never asked for.
 */
export function declaresPreferences(value: unknown): boolean {
  return isRecord(value) && value.preferences !== undefined
}

export function validatePreferences(value: unknown): NotificationPreferences {
  if (value === undefined) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  if (
    !isRecord(value) ||
    typeof value.turnCompleted !== 'boolean' ||
    typeof value.turnFailed !== 'boolean' ||
    typeof value.approval !== 'boolean' ||
    typeof value.question !== 'boolean' ||
    (value.subagentRuns !== undefined && typeof value.subagentRuns !== 'boolean') ||
    (value.bodyMode !== undefined && value.bodyMode !== 'full' && value.bodyMode !== 'summary')
  ) {
    throw new Error('subscription notification preferences are invalid')
  }
  return {
    turnCompleted: value.turnCompleted,
    turnFailed: value.turnFailed,
    approval: value.approval,
    question: value.question,
    // A record stored before this preference existed reads as "no subagent rows".
    subagentRuns: (value.subagentRuns ?? DEFAULT_NOTIFICATION_PREFERENCES.subagentRuns) as boolean,
    bodyMode: (value.bodyMode ?? DEFAULT_NOTIFICATION_PREFERENCES.bodyMode) as NotificationBodyMode,
  }
}

export function validateEndpoint(value: unknown): string {
  if (!isRecord(value) || typeof value.endpoint !== 'string') {
    throw new Error('subscription endpoint is missing')
  }
  return parseEndpoint(value.endpoint, 'subscription endpoint is invalid')
}

const MAX_PRESENCE_ID_LENGTH = 64
const PRESENCE_ID = /^[A-Za-z0-9_-]+$/

/**
 * A presence report names the page that sent it and whether that page is in
 * front of the user. The id is whatever the page invented for itself, so the
 * shape is the whole contract: it is never used as a path or a key of trust,
 * only as the name of an entry that expires on its own.
 */
export function validatePresence(value: unknown): PresenceReport {
  if (!isRecord(value)) throw new Error('presence report must be an object')
  const id = value.id
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PRESENCE_ID_LENGTH || !PRESENCE_ID.test(id)) {
    throw new Error('presence client id is invalid')
  }
  if (typeof value.active !== 'boolean') throw new Error('presence active flag must be a boolean')
  return { id, active: value.active }
}

/**
 * Both fields are required rather than defaulted: a caller that sends only one
 * of them is asking to change one thing, and treating the omission as "reset
 * the other" would silently undo a setting the user just chose.
 */
export function validateSettings(value: unknown): SuppressionSettings {
  if (!isRecord(value)) throw new Error('suppression settings must be an object')
  if (typeof value.suppressWhileActive !== 'boolean') {
    throw new Error('suppression settings need a boolean suppressWhileActive')
  }
  const idleMinutes = value.idleMinutes
  if (
    typeof idleMinutes !== 'number' ||
    !Number.isInteger(idleMinutes) ||
    idleMinutes < MIN_IDLE_MINUTES ||
    idleMinutes > MAX_IDLE_MINUTES
  ) {
    throw new Error(
      `suppression idleMinutes must be a whole number of minutes from ${String(MIN_IDLE_MINUTES)} to ${String(MAX_IDLE_MINUTES)}`,
    )
  }
  return { suppressWhileActive: value.suppressWhileActive, idleMinutes }
}

export const DEFAULT_TEST_MESSAGE = {
  title: 'DeepSeek Harness',
  body: 'Web Push is working.',
} as const

export interface TestMessage {
  readonly title: string
  readonly body: string
  readonly endpoint?: string
}

const MAX_TEST_TITLE_LENGTH = 120
const MAX_TEST_BODY_LENGTH = 1000

/**
 * The debug button ships fixed copy, which cannot answer the question an
 * operator actually has: how does a long or awkward notification wrap on this
 * phone. The body is therefore caller-supplied, defaulting to the original
 * strings so every existing caller keeps working. An absent field takes the
 * default; an explicit empty string is honoured, so a title-only notification
 * can be previewed.
 */
export function validateTestMessage(value: unknown): TestMessage {
  if (value === undefined) return { ...DEFAULT_TEST_MESSAGE }
  if (!isRecord(value)) throw new Error('test notification must be an object')
  return {
    title: testField(value.title, 'title', MAX_TEST_TITLE_LENGTH, DEFAULT_TEST_MESSAGE.title),
    body: testField(value.body, 'body', MAX_TEST_BODY_LENGTH, DEFAULT_TEST_MESSAGE.body),
    ...(value.endpoint === undefined ? {} : { endpoint: validateEndpoint(value) }),
  }
}

function testField(value: unknown, label: string, maxLength: number, fallback: string): string {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new Error(`test notification ${label} must be a string`)
  if (value.length > maxLength) {
    throw new Error(`test notification ${label} must be at most ${String(maxLength)} characters`)
  }
  return value
}

export function validateStoreState(value: unknown): PushStoreState {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.vapid) || !Array.isArray(value.subscriptions)) {
    throw new Error('push storage has an unsupported format')
  }
  const vapid: VapidKeys = {
    publicKey: validBase64Url(value.vapid.publicKey, 'VAPID public key'),
    privateKey: validBase64Url(value.vapid.privateKey, 'VAPID private key'),
  }
  const subscriptions = value.subscriptions.map(validateSubscription)
  const endpoints = new Set<string>()
  for (const subscription of subscriptions) {
    if (endpoints.has(subscription.endpoint)) throw new Error('push storage contains duplicate endpoints')
    endpoints.add(subscription.endpoint)
  }
  // A file written before suppression settings existed still opens, on defaults.
  const settings = value.settings === undefined ? { ...DEFAULT_SUPPRESSION_SETTINGS } : validateSettings(value.settings)
  return { version: 1, vapid, subscriptions, settings }
}

export function validBase64Url(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_KEY_LENGTH || !BASE64URL.test(value)) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function parseEndpoint(value: unknown, invalidMessage: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) {
    throw new Error(invalidMessage)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(invalidMessage)
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') {
    throw new Error('subscription endpoint must be an HTTPS URL without credentials or a fragment')
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new Error('subscription endpoint must not address a private, loopback, or link-local host')
  }
  return value
}

/**
 * A stored endpoint is the address the harness POSTs to on every notification,
 * so without this an authenticated client could aim the sender at its own LAN.
 * Every legitimate value is a public Push service the browser chose, so
 * rejecting the private ranges costs no real endpoint.
 *
 * This reads the host as written, which makes it a speed bump rather than a
 * wall: a name that resolves to a private address is accepted here, because the
 * lookup happens later, inside the sender, and a name can answer with a public
 * address now and a private one a moment later. An accepted endpoint is
 * therefore not proof that the destination is public; treat the operator as the
 * last line of defence and keep the route behind the session gate.
 */
function isPrivateHost(hostname: string): boolean {
  // A trailing dot is the same name to DNS. The URL parser drops it from a
  // dotted-quad address but keeps it on a name, so `localhost.` would otherwise
  // walk straight past the checks below.
  const unrooted = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase()
  const host = unrooted.endsWith('.') ? unrooted.slice(0, -1) : unrooted
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.includes(':')) {
    if (host === '::' || host === '::1') return true
    // ::ffff:127.0.0.1 addresses the same host as 127.0.0.1, and only the dotted
    // spelling reaches the IPv4 rules below, so unwrap the mapped form first.
    const mapped = mappedIpv4(host)
    if (mapped !== undefined) return isPrivateHost(mapped)
    // fc00::/7 unique-local and fe80::/10 link-local. Requiring the colon keeps
    // these from firing on a hostname that merely begins with "fc".
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true
    return false
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (octets === null) return false
  const first = Number(octets[1])
  const second = Number(octets[2])
  if (first === 0 || first === 10 || first === 127) return true
  if (first === 169 && second === 254) return true
  if (first === 172 && second >= 16 && second <= 31) return true
  if (first === 192 && second === 168) return true
  return false
}

/**
 * The IPv4 address an IPv4-mapped IPv6 literal stands for, in its dotted form,
 * or undefined for every other IPv6 address.
 *
 * The URL parser normalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`, so both
 * spellings are read here rather than trusting the one that happens to arrive.
 */
function mappedIpv4(host: string): string | undefined {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  if (dotted !== null) return dotted[1]
  const pair = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (pair === null) return undefined
  const high = Number.parseInt(pair[1] ?? '', 16)
  const low = Number.parseInt(pair[2] ?? '', 16)
  if (Number.isNaN(high) || Number.isNaN(low)) return undefined
  return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.${String(low & 0xff)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

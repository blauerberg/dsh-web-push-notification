import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationBodyMode,
  type NotificationPreferences,
  type PushSubscriptionRecord,
  type PushStoreState,
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

export function validatePreferences(value: unknown): NotificationPreferences {
  if (value === undefined) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  if (
    !isRecord(value) ||
    typeof value.turnCompleted !== 'boolean' ||
    typeof value.turnFailed !== 'boolean' ||
    typeof value.approval !== 'boolean' ||
    typeof value.question !== 'boolean' ||
    (value.bodyMode !== undefined && value.bodyMode !== 'full' && value.bodyMode !== 'summary')
  ) {
    throw new Error('subscription notification preferences are invalid')
  }
  return {
    turnCompleted: value.turnCompleted,
    turnFailed: value.turnFailed,
    approval: value.approval,
    question: value.question,
    bodyMode: (value.bodyMode ?? DEFAULT_NOTIFICATION_PREFERENCES.bodyMode) as NotificationBodyMode,
  }
}

export function validateEndpoint(value: unknown): string {
  if (!isRecord(value) || typeof value.endpoint !== 'string') {
    throw new Error('subscription endpoint is missing')
  }
  return parseEndpoint(value.endpoint, 'subscription endpoint is invalid')
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
  return { version: 1, vapid, subscriptions }
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
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

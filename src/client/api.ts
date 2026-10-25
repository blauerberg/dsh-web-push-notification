import type { PushSubscriptionJson, WebPushConfig } from '../contract.ts'
import type { NotificationPreferences, SuppressionSettings } from '../types.ts'

const BASE = '/__dsh/web-push'

export function loadConfig(): Promise<WebPushConfig> {
  return request<WebPushConfig>(`${BASE}/config`, { method: 'GET' })
}

/**
 * Ask the browser to re-fetch the worker when the section opens.
 *
 * The registration is created once, when notifications are first enabled, and
 * its scope covers no application page: an ordinary visit triggers no update
 * check at all, so a rebuilt worker would otherwise never reach a browser that
 * already had the previous one installed.
 */
export async function refreshServiceWorker(config: WebPushConfig): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerScope)
    await registration?.update()
  } catch {
    // An unreachable update check leaves the installed worker in charge.
  }
}

export function registerSubscription(
  subscription: PushSubscription,
  preferences: NotificationPreferences,
): Promise<void> {
  const json = { ...(subscription.toJSON() as PushSubscriptionJson), preferences }
  return request(`${BASE}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  }).then(() => undefined)
}

/** Store the account-wide suppression policy and return what the server kept. */
export function saveSuppression(settings: SuppressionSettings): Promise<SuppressionSettings> {
  return request(`${BASE}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export function unregisterSubscription(endpoint: string): Promise<void> {
  return request(`${BASE}/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).then(() => undefined)
}

export async function reconcileSubscription(
  config: WebPushConfig,
  preferences: NotificationPreferences,
): Promise<'missing' | 'mismatched' | 'registered'> {
  const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerScope)
  const subscription = await registration?.pushManager.getSubscription()
  if (subscription === undefined || subscription === null) return 'missing'
  if (!subscriptionUsesApplicationServerKey(subscription, config.publicKey)) return 'mismatched'
  await registerSubscription(subscription, preferences)
  return 'registered'
}

/** Wait for the registered worker instead of the page-global registration. */
export function waitForActiveServiceWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  if (registration.active !== null) return Promise.resolve(registration)
  const worker = registration.installing
  if (worker === null) return Promise.reject(new Error('The Web Push service worker did not start installing.'))
  return new Promise((resolve, reject) => {
    const onStateChange = (): void => {
      if (registration.active !== null) {
        worker.removeEventListener('statechange', onStateChange)
        resolve(registration)
      } else if (worker.state === 'redundant') {
        worker.removeEventListener('statechange', onStateChange)
        reject(new Error('The Web Push service worker became redundant before activation.'))
      }
    }
    worker.addEventListener('statechange', onStateChange)
    onStateChange()
  })
}

export interface TestNotificationRequest {
  /** Current device's endpoint; the response reports whether the host retained it. */
  readonly endpoint?: string
}

export function sendTest(message: TestNotificationRequest = {}): Promise<{
  readonly sent: number
  readonly removed: number
  readonly failed: number
  readonly subscriptionRegistered?: boolean
}> {
  return request(`${BASE}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
}

export function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  const result = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index)
  return result
}

export function subscriptionUsesApplicationServerKey(subscription: PushSubscription, value: string): boolean {
  const current = subscription.options.applicationServerKey
  if (current === null) return false
  const expected = applicationServerKey(value)
  const actual = new Uint8Array(current)
  return actual.length === expected.length && actual.every((byte, index) => byte === expected[index])
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  const text = await response.text()
  let value: unknown
  try {
    value = text === '' ? undefined : JSON.parse(text)
  } catch {
    value = undefined
  }
  if (!response.ok) {
    const error = isRecord(value) && typeof value.error === 'string' ? value.error : `HTTP ${String(response.status)}`
    throw new Error(error)
  }
  return value as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

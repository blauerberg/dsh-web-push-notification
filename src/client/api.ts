import { applicationServerKey } from '../application-server-key.ts'
import { WEB_PUSH_ROUTE_PREFIX, type PushSubscriptionJson, type WebPushConfig } from '../contract.ts'
import type { NotificationPreferences, SuppressionSettings } from '../types.ts'

export function loadConfig(): Promise<WebPushConfig> {
  return request<WebPushConfig>(`${WEB_PUSH_ROUTE_PREFIX}/config`, { method: 'GET' })
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
  return request(`${WEB_PUSH_ROUTE_PREFIX}/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(json),
  }).then(() => undefined)
}

/** Store the account-wide suppression policy and return what the server kept. */
export function saveSuppression(settings: SuppressionSettings): Promise<SuppressionSettings> {
  return request(`${WEB_PUSH_ROUTE_PREFIX}/settings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(settings),
  })
}

export function unregisterSubscription(endpoint: string): Promise<void> {
  return request(`${WEB_PUSH_ROUTE_PREFIX}/unsubscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  }).then(() => undefined)
}

export async function getSubscription(config: WebPushConfig): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerScope)
  return (await registration?.pushManager.getSubscription()) ?? null
}

export async function removeSubscription(subscription: PushSubscription): Promise<void> {
  await unregisterSubscription(subscription.endpoint)
  await subscription.unsubscribe()
}

export async function renewSubscription(config: WebPushConfig, preferences: NotificationPreferences): Promise<void> {
  const registration = await navigator.serviceWorker.register(config.serviceWorkerUrl, {
    scope: config.serviceWorkerScope,
  })
  await waitForActiveServiceWorker(registration)
  const subscription = await registration.pushManager.getSubscription()
  // The browser reports the key requested by the page, which can match stale
  // config even when the Push service rejects it. An explicit enable therefore
  // replaces the subscription instead of adopting the reported key.
  if (subscription !== null) await removeSubscription(subscription)
  const renewed = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(config.publicKey),
  })
  await registerSubscription(renewed, preferences)
}

export async function reconcileSubscription(
  config: WebPushConfig,
  preferences: NotificationPreferences,
  signal?: AbortSignal,
): Promise<'missing' | 'mismatched' | 'registered'> {
  const subscription = await getSubscription(config)
  signal?.throwIfAborted()
  if (subscription === null) return 'missing'
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
  return request(`${WEB_PUSH_ROUTE_PREFIX}/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(message),
  })
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

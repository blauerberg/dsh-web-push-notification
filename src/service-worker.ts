import { applicationServerKey } from './application-server-key.ts'
import { WEB_PUSH_ROUTE_PREFIX, type PushSubscriptionJson, type WebPushConfig } from './contract.ts'

const worker = self as unknown as ServiceWorkerGlobalScope & { Notification?: { maxActions?: number } }
const fallback = { title: 'DeepSeek Harness', body: 'A notification is ready.' }

// Without an icon, Chromium substitutes a disc carrying the origin's monogram.
const icon = new URL('notification-icon.png', worker.location.href).href
const badge = new URL('notification-badge.png', worker.location.href).href
const reportedActions = Number(worker.Notification?.maxActions ?? 0)
const actionLimit = reportedActions > 0 ? Math.min(reportedActions, 2) : 2
const actions = [
  { action: 'open', title: 'Open' },
  { action: 'dismiss', title: 'Dismiss' },
].slice(0, actionLimit)

worker.addEventListener('install', () => worker.skipWaiting())
worker.addEventListener('activate', (event) => event.waitUntil(worker.clients.claim()))

function payloadOf(event: PushEvent): Record<string, unknown> {
  if (!event.data) return fallback
  try {
    const value: unknown = event.data.json()
    if (value && typeof value === 'object') return value as Record<string, unknown>
  } catch {
    // Invalid payloads still produce a visible notification.
  }
  return fallback
}

worker.addEventListener('push', (event) => {
  const value = payloadOf(event)
  const title = typeof value.title === 'string' && value.title !== '' ? value.title : fallback.title
  const body = typeof value.body === 'string' ? value.body : fallback.body
  const tag = typeof value.tag === 'string' && value.tag !== '' ? value.tag : undefined
  const data = {
    url: typeof value.url === 'string' ? value.url : '/',
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
  }
  const options: NotificationOptions & { renotify?: boolean; actions?: typeof actions } = { body, data, icon, badge }
  if (tag !== undefined) {
    options.tag = tag
    // Replacement notifications would otherwise arrive silently.
    options.renotify = true
  }
  if (actions.length > 0) options.actions = actions
  event.waitUntil(worker.registration.showNotification(title, options))
})

worker.addEventListener('notificationclick', (event) => {
  event.notification.close()
  if (event.action === 'dismiss') return
  const data = event.notification.data as { url?: unknown; sessionId?: unknown } | undefined
  let target = `${worker.location.origin}/`
  try {
    const url = new URL(typeof data?.url === 'string' ? data.url : '/', worker.location.origin)
    if (url.origin === worker.location.origin) target = url.href
  } catch {
    // Keep the same-origin root for malformed click data.
  }
  event.waitUntil(
    (async () => {
      const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = clients.find((client) => {
        try {
          return new URL(client.url).origin === worker.location.origin
        } catch {
          return false
        }
      })
      if (existing) {
        if (typeof data?.sessionId === 'string' && data.sessionId !== '') {
          existing.postMessage({ type: 'dsh-web-push/open-session', sessionId: data.sessionId })
        }
        await existing.focus()
      } else {
        await worker.clients.openWindow(target)
      }
    })(),
  )
})

async function post(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  // A rejected POST resolves too; retiring the old endpoint requires a stored replacement.
  if (!response.ok) throw new Error(`${path} answered ${String(response.status)}`)
}

worker.addEventListener('pushsubscriptionchange', (event) => {
  const replaced = event.oldSubscription?.endpoint
  event.waitUntil(
    (async () => {
      try {
        let next = event.newSubscription
        if (!next) {
          const response = await fetch(`${WEB_PUSH_ROUTE_PREFIX}/config`, { credentials: 'same-origin' })
          if (!response.ok) throw new Error(`Web Push config answered ${String(response.status)}`)
          const config: WebPushConfig = await response.json()
          next = await worker.registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationServerKey(config.publicKey),
          })
        }
        // The server retains the replaced endpoint's preferences across browser rotation.
        const body: PushSubscriptionJson = { ...next.toJSON(), endpoint: next.endpoint, previousEndpoint: replaced }
        await post(`${WEB_PUSH_ROUTE_PREFIX}/subscribe`, body)
        if (replaced !== undefined && replaced !== next.endpoint) {
          await post(`${WEB_PUSH_ROUTE_PREFIX}/unsubscribe`, { endpoint: replaced })
        }
      } catch {
        // An unavailable host leaves the old record available for recovery.
      }
    })(),
  )
})

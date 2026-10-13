import { describe, expect, it } from 'vitest'
import { SERVICE_WORKER_SOURCE } from '../src/service-worker.ts'

interface WorkerCall {
  readonly path: string
  readonly body: Record<string, unknown> | undefined
}

interface WorkerHarness {
  readonly calls: WorkerCall[]
  fire(type: string, event: Record<string, unknown>): Promise<void>
}

/**
 * Run the shipped worker source against a fake service worker global scope, so a
 * change to what the worker *does* is caught by behaviour rather than by a string
 * that happens to still be in the file.
 */
function loadWorker(respond: (path: string) => { ok: boolean; status: number }): WorkerHarness {
  const listeners = new Map<string, (event: never) => void>()
  const calls: WorkerCall[] = []
  const pending: Promise<unknown>[] = []
  const scope = {
    location: new URL('https://harness.example/__dsh/web-push/sw.js'),
    Notification: { maxActions: 2 },
    registration: {
      showNotification: async () => {},
      pushManager: {
        subscribe: async () => ({ endpoint: 'https://push.example.test/subscribed', toJSON: () => ({}) }),
      },
    },
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    skipWaiting: async () => {},
    addEventListener(type: string, listener: (event: never) => void) {
      listeners.set(type, listener)
    },
  }
  const fetchStub = async (path: string, init?: { body?: string }) => {
    calls.push({
      path,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    })
    const answer = respond(path)
    return { ok: answer.ok, status: answer.status, json: async () => ({ publicKey: 'AQID' }) }
  }
  new Function('self', 'fetch', SERVICE_WORKER_SOURCE)(scope, fetchStub)
  return {
    calls,
    async fire(type, event) {
      const listener = listeners.get(type)
      const waited: { waitUntil(value: Promise<unknown>): void } = { waitUntil: (value) => pending.push(value) }
      listener?.({ ...waited, ...event } as never)
      await Promise.all(pending)
    },
  }
}

describe('Service Worker source', () => {
  it('always displays push payloads and handles same-origin clicks without caching the app', () => {
    expect(SERVICE_WORKER_SOURCE).toContain('showNotification')
    expect(SERVICE_WORKER_SOURCE).toContain('notificationclick')
    expect(SERVICE_WORKER_SOURCE).toContain('dsh-web-push/open-session')
    expect(SERVICE_WORKER_SOURCE).toContain('openWindow')
    expect(SERVICE_WORKER_SOURCE).not.toContain('caches.open')
  })

  it('renews a rotated Push subscription without a page in the loop', () => {
    expect(SERVICE_WORKER_SOURCE).toContain("addEventListener('pushsubscriptionchange'")
    expect(SERVICE_WORKER_SOURCE).toContain('event.oldSubscription')
    expect(SERVICE_WORKER_SOURCE).toContain('event.newSubscription')
    expect(SERVICE_WORKER_SOURCE).toContain('pushManager.subscribe')
    expect(SERVICE_WORKER_SOURCE).toContain('/__dsh/web-push/subscribe')
    expect(SERVICE_WORKER_SOURCE).toContain('/__dsh/web-push/unsubscribe')
    // The replacement is named so the server can carry the device's preferences
    // across, and no response is trusted before it has been checked.
    expect(SERVICE_WORKER_SOURCE).toContain('previousEndpoint')
    expect(SERVICE_WORKER_SOURCE).toContain('response.ok')
    expect(SERVICE_WORKER_SOURCE).not.toContain('caches.open')
  })

  it('keeps the old endpoint when the replacement could not be stored', async () => {
    const worker = loadWorker((path) =>
      path.endsWith('/subscribe') ? { ok: false, status: 500 } : { ok: true, status: 200 },
    )
    await worker.fire('pushsubscriptionchange', {
      oldSubscription: { endpoint: 'https://push.example.test/old' },
      newSubscription: {
        endpoint: 'https://push.example.test/new',
        toJSON: () => ({ endpoint: 'https://push.example.test/new' }),
      },
    })
    // Retiring the old endpoint here would leave the device with no reachable
    // subscription at all.
    expect(worker.calls.map((call) => call.path)).toEqual(['/__dsh/web-push/subscribe'])
  })

  it('names the replaced endpoint, and retires it only after the new one is stored', async () => {
    const worker = loadWorker(() => ({ ok: true, status: 200 }))
    await worker.fire('pushsubscriptionchange', {
      oldSubscription: { endpoint: 'https://push.example.test/old' },
      newSubscription: {
        endpoint: 'https://push.example.test/new',
        toJSON: () => ({
          endpoint: 'https://push.example.test/new',
          keys: { p256dh: 'AQID', auth: 'BAUG' },
        }),
      },
    })
    expect(worker.calls.map((call) => call.path)).toEqual(['/__dsh/web-push/subscribe', '/__dsh/web-push/unsubscribe'])
    // The subscription carries no preferences: those live in localStorage, which
    // the worker cannot read.
    expect(worker.calls[0]?.body).toEqual({
      endpoint: 'https://push.example.test/new',
      keys: { p256dh: 'AQID', auth: 'BAUG' },
      previousEndpoint: 'https://push.example.test/old',
    })
    expect(worker.calls[1]?.body).toEqual({ endpoint: 'https://push.example.test/old' })
  })

  it('ships a large icon and a status-bar badge with every notification', () => {
    expect(SERVICE_WORKER_SOURCE).toContain("new URL('notification-icon.png', self.location)")
    expect(SERVICE_WORKER_SOURCE).toContain("new URL('notification-badge.png', self.location)")
    expect(SERVICE_WORKER_SOURCE).toContain('const options = { body, data, icon, badge }')
  })

  it('offers an Open action, and a Dismiss one wherever the platform has room', () => {
    expect(SERVICE_WORKER_SOURCE).toContain('self.Notification.maxActions')
    // The browser drops actions past the platform's limit when the notification
    // is created; it does not reject the call. The cap therefore only decides
    // whether a second button is worth building.
    expect(SERVICE_WORKER_SOURCE).toContain('Math.min(reportedActions, 2)')
    expect(SERVICE_WORKER_SOURCE).toContain("{ action: 'open', title: 'Open' }")
    expect(SERVICE_WORKER_SOURCE).toContain("{ action: 'dismiss', title: 'Dismiss' }")
    expect(SERVICE_WORKER_SOURCE).toContain("if (event.action === 'dismiss') return;")
  })

  it('re-alerts when it replaces a row for the same session', () => {
    // The tag is stable per session and kind, so the replacement must still ring.
    expect(SERVICE_WORKER_SOURCE).toContain('options.tag = tag')
    expect(SERVICE_WORKER_SOURCE).toContain('options.renotify = true')
  })

  it('takes over the moment a rebuilt worker installs', () => {
    expect(SERVICE_WORKER_SOURCE).toContain("addEventListener('install'")
    expect(SERVICE_WORKER_SOURCE).toContain('self.skipWaiting()')
    expect(SERVICE_WORKER_SOURCE).toContain("addEventListener('activate'")
    expect(SERVICE_WORKER_SOURCE).toContain('self.clients.claim()')
  })
})

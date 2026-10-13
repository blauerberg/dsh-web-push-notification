import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESENCE_PATH, SETTINGS_PATH } from '../src/contract.ts'
import { PresenceRegistry } from '../src/presence.ts'
import {
  createPushRoutes,
  CONFIG_PATH,
  NOTIFICATION_BADGE_PATH,
  NOTIFICATION_ICON_PATH,
  SERVICE_WORKER_PATH,
  type PushRouteOptions,
} from '../src/routes.ts'
import type { PushSender } from '../src/sender.ts'
import { SERVICE_WORKER_SOURCE } from '../src/service-worker.ts'
import { PushStore } from '../src/store.ts'

const subscription = {
  endpoint: 'https://push.example.test/send/one',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true, bodyMode: 'full' as const },
}

let root: string | undefined
let presence = new PresenceRegistry()
const authenticated = () => undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  presence = new PresenceRegistry()
})

/** Every route test shares one presence registry, so a report can be observed. */
function routesFor(options: Omit<PushRouteOptions, 'presence'>): ReturnType<typeof createPushRoutes> {
  return createPushRoutes({ presence, ...options })
}

function request(method: string, body?: unknown, contentType = 'application/json'): IncomingMessage {
  const raw = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    headers:
      raw === ''
        ? { host: '127.0.0.1' }
        : { host: '127.0.0.1', 'content-type': contentType, 'content-length': String(Buffer.byteLength(raw)) },
    async *[Symbol.asyncIterator]() {
      if (raw !== '') yield Buffer.from(raw)
    },
  } as unknown as IncomingMessage
}

function response(): {
  response: ServerResponse
  status: number
  headers: Record<string, unknown>
  body: unknown
  raw: unknown
} {
  let status = 0
  let headers: Record<string, unknown> = {}
  let body: unknown
  let raw: unknown
  const value = {
    response: {
      writeHead(code: number, written?: Record<string, unknown>) {
        status = code
        headers = written ?? {}
      },
      end(value?: unknown) {
        raw = value
        const text = value === undefined ? undefined : String(value)
        try {
          body = text === undefined ? undefined : JSON.parse(text)
        } catch {
          body = text
        }
      },
    } as unknown as ServerResponse,
    get status() {
      return status
    },
    get headers() {
      return headers
    },
    get body() {
      return body
    },
    get raw() {
      return raw
    },
  }
  return value
}

function find(path: string, routes: ReturnType<typeof createPushRoutes>) {
  const route = routes.find((item) => item.path === path)
  if (route === undefined) throw new Error(`missing route ${path}`)
  return route
}

describe('Web Push routes', () => {
  it('serves public configuration and a push-only Service Worker', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const sender: PushSender = { send: vi.fn(async () => {}) }
    const routes = routesFor({ store, sender, maxRequestBodyBytes: 1024, requestRejection: authenticated })
    const config = response()
    await find(CONFIG_PATH, routes).handler(request('GET'), config.response)
    expect(config.status).toBe(200)
    // A cached key is enough to bind a new subscription to a key pair the host no
    // longer signs with, so the answer carrying the key is never cached.
    expect(config.headers['cache-control']).toBe('no-store')
    expect(config.body).toEqual({
      publicKey: 'AQID',
      serviceWorkerUrl: SERVICE_WORKER_PATH,
      serviceWorkerScope: '/__dsh/web-push/',
      suppression: { suppressWhileActive: true, idleMinutes: 10 },
    })

    const worker = response()
    await find(SERVICE_WORKER_PATH, routes).handler(request('GET'), worker.response)
    expect(worker.status).toBe(200)
  })

  it('stores subscriptions and removes expired endpoints after a 410', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const sender: PushSender = {
      send: vi.fn(async (value) => {
        if (value.endpoint.endsWith('/one')) throw Object.assign(new Error('gone'), { statusCode: 410 })
      }),
    }
    const routes = routesFor({ store, sender, maxRequestBodyBytes: 1024, requestRejection: authenticated })
    const subscribe = response()
    await find('/__dsh/web-push/subscribe', routes).handler(request('POST', subscription), subscribe.response)
    expect(subscribe.status).toBe(200)
    expect(store.list()).toHaveLength(1)

    const test = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', {}), test.response)
    expect(test.body).toEqual({ sent: 0, removed: 1, failed: 0 })
    expect(store.list()).toEqual([])
  })

  it('drops a subscription the Push service refuses this deployment\u2019s key pair for', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    const routes = routesFor({
      store,
      sender: {
        send: vi.fn(async () => {
          // What FCM answers a record that was registered under another VAPID
          // key pair: the store was regenerated, the browser kept the
          // subscription it made with the previous pair.
          throw Object.assign(new Error('received unexpected response code'), {
            statusCode: 403,
            body: 'the VAPID credentials in the authorization header do not correspond to the credentials used to create the subscriptions.',
          })
        }),
      },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })
    const test = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', {}), test.response)
    expect(test.status).toBe(200)
    expect(test.body).toEqual({ sent: 0, removed: 1, failed: 0 })
    expect(store.list()).toEqual([])
  })

  it('keeps a subscription a 403 refuses for any other reason', async () => {
    // Only the service's own statement that the credentials do not match is
    // permanent. An unrelated 403 must not throw away a record that a later
    // event can still reach.
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    const routes = routesFor({
      store,
      sender: {
        send: vi.fn(async () => {
          throw Object.assign(new Error('forbidden'), { statusCode: 403, body: 'sender is not authorized' })
        }),
      },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })
    const test = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', {}), test.response)
    expect(test.body).toEqual({ sent: 0, removed: 0, failed: 1 })
    expect(store.list()).toHaveLength(1)
  })

  it('carries a rotated subscription\u2019s preferences over from the endpoint it replaces', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const routes = routesFor({
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })
    const chosen = {
      turnCompleted: false,
      turnFailed: true,
      approval: false,
      question: false,
      subagentRuns: false,
      bodyMode: 'summary' as const,
    }
    const first = response()
    await find('/__dsh/web-push/subscribe', routes).handler(
      request('POST', { ...subscription, preferences: chosen }),
      first.response,
    )
    expect(first.status).toBe(200)

    // What the worker sends after the browser rotates the subscription: new keys,
    // no preferences of its own, and the endpoint being replaced.
    const rotated = response()
    await find('/__dsh/web-push/subscribe', routes).handler(
      request('POST', {
        endpoint: 'https://push.example.test/send/two',
        expirationTime: null,
        keys: { p256dh: 'AQID', auth: 'BAUG' },
        previousEndpoint: subscription.endpoint,
      }),
      rotated.response,
    )
    expect(rotated.status).toBe(200)
    expect(store.list().find((record) => record.endpoint.endsWith('/two'))?.preferences).toEqual(chosen)

    // A first registration still gets the defaults, and so does a renewal that
    // names an endpoint this host has never seen.
    for (const endpoint of ['https://push.example.test/send/three', 'https://push.example.test/send/four']) {
      const fresh = response()
      await find('/__dsh/web-push/subscribe', routes).handler(
        request('POST', {
          endpoint,
          expirationTime: null,
          keys: { p256dh: 'AQID', auth: 'BAUG' },
          ...(endpoint.endsWith('/four') ? { previousEndpoint: 'https://push.example.test/unknown' } : {}),
        }),
        fresh.response,
      )
      expect(fresh.status, endpoint).toBe(200)
      expect(store.list().find((record) => record.endpoint === endpoint)?.preferences.bodyMode, endpoint).toBe('full')
    }
  })

  it('keeps a failed delivery from rejecting the test route', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    const routes = routesFor({
      store,
      sender: {
        send: vi.fn(async () => {
          throw new Error('network down')
        }),
      },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })
    const test = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', {}), test.response)
    expect(test.status).toBe(200)
    expect(test.body).toEqual({ sent: 0, removed: 0, failed: 1 })
    expect(store.list()).toHaveLength(1)
  })

  it('reports malformed client input without presenting a server failure', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const routes = routesFor({
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })

    const invalidSubscription = response()
    await find('/__dsh/web-push/subscribe', routes).handler(
      request('POST', { ...subscription, endpoint: 'http://push.example.test/send/one' }),
      invalidSubscription.response,
    )
    expect(invalidSubscription.status).toBe(400)
    expect(invalidSubscription.body).toEqual({
      error: 'subscription endpoint must be an HTTPS URL without credentials or a fragment',
    })

    const invalidContentType = response()
    await find('/__dsh/web-push/subscribe', routes).handler(
      request('POST', subscription, 'application/jsonp'),
      invalidContentType.response,
    )
    expect(invalidContentType.status).toBe(415)
  })

  it('rejects requests that are not authenticated by the Harness connection', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const routes = routesFor({
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: () => 401,
    })
    const result = response()
    await find(CONFIG_PATH, routes).handler(request('GET'), result.response)
    expect(result.status).toBe(401)
    expect(result.body).toBe('unauthorized')
  })

  it('forwards caller-supplied copy to the test notification', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    const sent: string[] = []
    const routes = routesFor({
      store,
      sender: { send: async (_subscription, payload) => void sent.push(String(payload)) },
      maxRequestBodyBytes: 4096,
      requestRejection: authenticated,
    })

    const test = response()
    await find('/__dsh/web-push/test', routes).handler(
      request('POST', { title: 'Build finished', body: 'line one\nline two' }),
      test.response,
    )
    expect(test.status).toBe(200)
    expect(sent).toHaveLength(1)
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      title: 'Build finished',
      body: 'line one\nline two',
    })
  })

  it('keeps the original copy when the test request carries none', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    const sent: string[] = []
    const routes = routesFor({
      store,
      sender: { send: async (_subscription, payload) => void sent.push(String(payload)) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })

    const test = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', {}), test.response)
    expect(test.status).toBe(200)
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      title: 'DeepSeek Harness',
      body: 'Web Push is working.',
    })
  })

  it('reports invalid test copy without sending anything', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    let deliveries = 0
    const routes = routesFor({
      store,
      sender: {
        send: async () => {
          deliveries += 1
        },
      },
      maxRequestBodyBytes: 4096,
      requestRejection: authenticated,
    })

    const notAString = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', { title: 42 }), notAString.response)
    expect(notAString.status).toBe(400)
    expect(notAString.body).toEqual({ error: 'test notification title must be a string' })

    const tooLong = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', { body: 'x'.repeat(1001) }), tooLong.response)
    expect(tooLong.status).toBe(400)
    expect(deliveries).toBe(0)
  })

  it('serves the notification artwork even when no session is presented', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-icons-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const routes = routesFor({
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      // The browser fetches a notification's icon itself, with no app cookie.
      requestRejection: () => 401,
    })
    const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    for (const path of [NOTIFICATION_ICON_PATH, NOTIFICATION_BADGE_PATH]) {
      const result = response()
      await find(path, routes).handler(request('GET'), result.response)
      expect(result.status, path).toBe(200)
      expect(Buffer.isBuffer(result.raw), path).toBe(true)
      expect((result.raw as Buffer).subarray(0, 8).equals(pngSignature), path).toBe(true)
      expect(result.headers['cache-control'], path).toBe('no-store')
    }
  })

  it('resolves the artwork the worker asks for to the route that serves it', () => {
    // The worker names the artwork relative to itself. A route registered at any
    // other path would 404, and Chrome would draw the origin's grey monogram
    // disc in the large-icon slot instead of the whale.
    const named = ['notification-icon.png', 'notification-badge.png'].filter((fileName) =>
      SERVICE_WORKER_SOURCE.includes(`new URL('${fileName}', self.location)`),
    )
    expect(named).toEqual(['notification-icon.png', 'notification-badge.png'])
    const worker = new URL(SERVICE_WORKER_PATH, 'https://example.test')
    expect(new URL('notification-icon.png', worker).pathname).toBe(NOTIFICATION_ICON_PATH)
    expect(new URL('notification-badge.png', worker).pathname).toBe(NOTIFICATION_BADGE_PATH)
  })

  it('records a page that is in front of the user', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-presence-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const routes = routesFor({
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })

    const accepted = response()
    await find(PRESENCE_PATH, routes).handler(request('POST', { id: 'page-1', active: true }), accepted.response)
    expect(accepted.status).toBe(200)
    expect(accepted.body).toEqual({ ok: true, suppression: { suppressWhileActive: true, idleMinutes: 10 } })
    expect(presence.anyActive()).toBe(true)

    for (const id of ['', 'x'.repeat(65), 'has space', 'slash/es', 42, null]) {
      const rejected = response()
      await find(PRESENCE_PATH, routes).handler(request('POST', { id, active: true }), rejected.response)
      expect(rejected.status, String(id)).toBe(400)
    }
    const notBoolean = response()
    await find(PRESENCE_PATH, routes).handler(request('POST', { id: 'page-1', active: 'yes' }), notBoolean.response)
    expect(notBoolean.status).toBe(400)
    // A malformed report is ignored, never a state change.
    expect(presence.anyActive()).toBe(true)
  })

  it('serves presence only over an authenticated POST carrying JSON', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-presence-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const dependencies = {
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    }

    const wrongMethod = response()
    await find(PRESENCE_PATH, routesFor(dependencies)).handler(request('GET'), wrongMethod.response)
    expect(wrongMethod.status).toBe(405)

    const wrongType = response()
    await find(PRESENCE_PATH, routesFor(dependencies)).handler(
      request('POST', { id: 'page-1', active: true }, 'application/jsonp'),
      wrongType.response,
    )
    expect(wrongType.status).toBe(415)

    const unauthenticated = response()
    const gated = createPushRoutes({ ...dependencies, presence, requestRejection: () => 401 })
    await find(PRESENCE_PATH, gated).handler(request('POST', { id: 'page-1', active: true }), unauthenticated.response)
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticated.body).toBe('unauthorized')
    expect(presence.anyActive()).toBe(false)
  })

  it('stores the suppression policy and hands it back to every open page', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-settings-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const routes = routesFor({
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    })

    const saved = response()
    await find(SETTINGS_PATH, routes).handler(
      request('POST', { suppressWhileActive: false, idleMinutes: 2 }),
      saved.response,
    )
    expect(saved.status).toBe(200)
    expect(saved.body).toEqual({ suppressWhileActive: false, idleMinutes: 2 })
    expect(store.settings).toEqual({ suppressWhileActive: false, idleMinutes: 2 })

    // The panel is not the only reader: a page already open learns the new
    // window from the answer to its next report, without a reload.
    const report = response()
    await find(PRESENCE_PATH, routes).handler(request('POST', { id: 'page-1', active: true }), report.response)
    expect(report.body).toEqual({ ok: true, suppression: { suppressWhileActive: false, idleMinutes: 2 } })
  })

  it('refuses a suppression policy it cannot honour', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-settings-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const route = find(
      SETTINGS_PATH,
      routesFor({
        store,
        sender: { send: vi.fn(async () => {}) },
        maxRequestBodyBytes: 1024,
        requestRejection: authenticated,
      }),
    )

    const bodies: unknown[] = [
      {},
      { idleMinutes: 5 },
      { suppressWhileActive: 'yes', idleMinutes: 5 },
      { suppressWhileActive: true, idleMinutes: 0 },
      { suppressWhileActive: true, idleMinutes: 2.5 },
      { suppressWhileActive: true, idleMinutes: 61 },
    ]
    for (const body of bodies) {
      const rejected = response()
      await route.handler(request('POST', body), rejected.response)
      expect(rejected.status, JSON.stringify(body)).toBe(400)
    }
    // Nothing was applied, so the panel and the pages keep the previous answer.
    expect(store.settings).toEqual({ suppressWhileActive: true, idleMinutes: 10 })
  })

  it('serves settings only over an authenticated POST carrying JSON', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-settings-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    const dependencies = {
      store,
      sender: { send: vi.fn(async () => {}) },
      maxRequestBodyBytes: 1024,
      requestRejection: authenticated,
    }

    const wrongMethod = response()
    await find(SETTINGS_PATH, routesFor(dependencies)).handler(request('GET'), wrongMethod.response)
    expect(wrongMethod.status).toBe(405)

    const unauthenticated = response()
    await find(SETTINGS_PATH, createPushRoutes({ ...dependencies, presence, requestRejection: () => 401 })).handler(
      request('POST', { suppressWhileActive: false, idleMinutes: 5 }),
      unauthenticated.response,
    )
    expect(unauthenticated.status).toBe(401)
    expect(store.settings.suppressWhileActive).toBe(true)
  })
})

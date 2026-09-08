import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPushRoutes, CONFIG_PATH, SERVICE_WORKER_PATH } from '../src/routes.ts'
import type { PushSender } from '../src/sender.ts'
import { PushStore } from '../src/store.ts'

const subscription = {
  endpoint: 'https://push.example.test/send/one',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true, bodyMode: 'full' as const },
}

let root: string | undefined
const authenticated = () => undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

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

function response(): { response: ServerResponse; status: number; body: unknown } {
  let status = 0
  let body: unknown
  const value = {
    response: {
      writeHead(code: number) {
        status = code
      },
      end(value?: unknown) {
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
    get body() {
      return body
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
    const routes = createPushRoutes({ store, sender, maxRequestBodyBytes: 1024, requestRejection: authenticated })
    const config = response()
    await find(CONFIG_PATH, routes).handler(request('GET'), config.response)
    expect(config.status).toBe(200)
    expect(config.body).toEqual({
      publicKey: 'AQID',
      serviceWorkerUrl: SERVICE_WORKER_PATH,
      serviceWorkerScope: '/__dsh/web-push/',
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
    const routes = createPushRoutes({ store, sender, maxRequestBodyBytes: 1024, requestRejection: authenticated })
    const subscribe = response()
    await find('/__dsh/web-push/subscribe', routes).handler(request('POST', subscription), subscribe.response)
    expect(subscribe.status).toBe(200)
    expect(store.list()).toHaveLength(1)

    const test = response()
    await find('/__dsh/web-push/test', routes).handler(request('POST', {}), test.response)
    expect(test.body).toEqual({ sent: 0, removed: 1, failed: 0 })
    expect(store.list()).toEqual([])
  })

  it('keeps a failed delivery from rejecting the test route', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-routes-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription)
    const routes = createPushRoutes({
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
    const routes = createPushRoutes({
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
    const routes = createPushRoutes({
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
})

import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { NOTIFICATION_BADGE_PATH, NOTIFICATION_ICON_PATH } from '../src/routes.ts'

const source = readFileSync(new URL('../lib/service-worker.js', import.meta.url), 'utf8')

interface WorkerCall {
  readonly path: string
  readonly init: RequestInit | undefined
  readonly body: Record<string, unknown> | undefined
}

type WorkerClient = Pick<WindowClient, 'url'> & {
  focus(): Promise<void>
  postMessage(message: unknown): void
}

type DisplayOptions = NotificationOptions & {
  actions?: Array<{ action: string; title: string }>
  renotify?: boolean
}

function browserSubscription(endpoint = 'https://push.example.test/new') {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'AQID', auth: 'BAUG' } }),
  }
}

function loadWorker(respond: (path: string) => number = () => 200, maxActions = 2) {
  const listeners = new Map<string, (event: Record<string, unknown>) => unknown>()
  const calls: WorkerCall[] = []
  const scope = {
    location: new URL('https://harness.example/__dsh/web-push/sw.js'),
    Notification: { maxActions },
    registration: {
      showNotification: vi.fn(async (_title: string, _options: DisplayOptions) => {}),
      pushManager: {
        subscribe: vi.fn(async (_options: PushSubscriptionOptionsInit) => browserSubscription()),
      },
    },
    clients: {
      claim: vi.fn(async () => {}),
      matchAll: vi.fn(async (_options: ClientQueryOptions): Promise<WorkerClient[]> => []),
      openWindow: vi.fn(async (_url: string) => {}),
    },
    skipWaiting: vi.fn(async () => {}),
    addEventListener(type: string, listener: (event: Record<string, unknown>) => unknown) {
      listeners.set(type, listener)
    },
  }
  const fetchStub = async (path: string, init?: RequestInit) => {
    calls.push({
      path,
      init,
      body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
    })
    return new Response(JSON.stringify({ publicKey: '-_8' }), { status: respond(path) })
  }
  new Function('self', 'fetch', source)(scope, fetchStub)
  return {
    scope,
    calls,
    listeners,
    async fire(type: string, event: Record<string, unknown> = {}) {
      const listener = listeners.get(type)
      if (listener === undefined) throw new Error(`missing worker listener: ${type}`)
      const pending: Promise<unknown>[] = []
      await listener({ ...event, waitUntil: (value: Promise<unknown>) => pending.push(value) })
      await Promise.all(pending)
    },
  }
}

describe('Service Worker behavior', () => {
  it('displays the payload with artwork served by the registered routes and re-alerts on replacement', async () => {
    const worker = loadWorker()
    await worker.fire('push', {
      data: {
        json: () => ({ title: 'Done', body: 'The answer.', url: '/session/one', sessionId: 'one', tag: 'turn-one' }),
      },
    })
    expect(worker.scope.registration.showNotification).toHaveBeenCalledWith('Done', {
      body: 'The answer.',
      data: { url: '/session/one', sessionId: 'one' },
      icon: new URL(NOTIFICATION_ICON_PATH, worker.scope.location).href,
      badge: new URL(NOTIFICATION_BADGE_PATH, worker.scope.location).href,
      tag: 'turn-one',
      renotify: true,
      actions: [
        { action: 'open', title: 'Open' },
        { action: 'dismiss', title: 'Dismiss' },
      ],
    })
  })

  it.each([
    undefined,
    {
      json: () => {
        throw new Error('invalid JSON')
      },
    },
    { json: () => null },
    { json: () => 42 },
    { json: () => ({ title: '', body: 42, tag: '', url: null, sessionId: false }) },
  ])('displays fallback text for unusable push data: %j', async (data) => {
    const worker = loadWorker()
    await worker.fire('push', { data })
    const [[title, options]] = worker.scope.registration.showNotification.mock.calls
    expect(title).toBe('DeepSeek Harness')
    expect(options.body).toBe('A notification is ready.')
    expect(options.data).toEqual({ url: '/', sessionId: undefined })
    expect(options.tag).toBeUndefined()
    expect(options.renotify).toBeUndefined()
  })

  it.each([
    [1, ['open']],
    [2, ['open', 'dismiss']],
    [5, ['open', 'dismiss']],
    [0, ['open', 'dismiss']],
    [Number.NaN, ['open', 'dismiss']],
  ])('offers actions within the platform limit of %s', async (limit, expected) => {
    const worker = loadWorker(undefined, limit)
    await worker.fire('push')
    const [[, options]] = worker.scope.registration.showNotification.mock.calls
    expect(options.actions?.map((action) => action.action)).toEqual(expected)
  })

  it.each([
    ['/session/one', 'https://harness.example/session/one'],
    ['https://harness.example/session/two', 'https://harness.example/session/two'],
    ['https://other.example/session/one', 'https://harness.example/'],
    ['http://[invalid', 'https://harness.example/'],
    [undefined, 'https://harness.example/'],
  ])('opens a same-origin destination for click data %s', async (url, expected) => {
    const worker = loadWorker()
    const close = vi.fn()
    await worker.fire('notificationclick', { action: 'open', notification: { close, data: { url } } })
    expect(close).toHaveBeenCalledOnce()
    expect(worker.scope.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
    expect(worker.scope.clients.openWindow).toHaveBeenCalledWith(expected)
  })

  it.each(['one', undefined])(
    'focuses an existing app window and forwards session %s when supplied',
    async (sessionId) => {
      const worker = loadWorker()
      const existing = { url: 'https://harness.example/other', focus: vi.fn(async () => {}), postMessage: vi.fn() }
      const foreign = { url: 'https://other.example/', focus: vi.fn(async () => {}), postMessage: vi.fn() }
      worker.scope.clients.matchAll.mockResolvedValue([{ ...foreign, url: 'not a URL' }, foreign, existing])
      await worker.fire('notificationclick', {
        notification: { close: vi.fn(), data: { url: '/session/one', sessionId } },
      })
      expect(existing.focus).toHaveBeenCalledOnce()
      expect(foreign.focus).not.toHaveBeenCalled()
      expect(foreign.postMessage).not.toHaveBeenCalled()
      if (sessionId === undefined) expect(existing.postMessage).not.toHaveBeenCalled()
      else expect(existing.postMessage).toHaveBeenCalledWith({ type: 'dsh-web-push/open-session', sessionId })
      expect(worker.scope.clients.openWindow).not.toHaveBeenCalled()
    },
  )

  it('dismisses without opening or focusing an app window', async () => {
    const worker = loadWorker()
    const close = vi.fn()
    await worker.fire('notificationclick', { action: 'dismiss', notification: { close } })
    expect(close).toHaveBeenCalledOnce()
    expect(worker.scope.clients.matchAll).not.toHaveBeenCalled()
    expect(worker.scope.clients.openWindow).not.toHaveBeenCalled()
  })

  it('takes over on install and activation without intercepting application fetches', async () => {
    const worker = loadWorker()
    await worker.fire('install')
    expect(worker.scope.skipWaiting).toHaveBeenCalledOnce()
    await worker.fire('activate')
    expect(worker.scope.clients.claim).toHaveBeenCalledOnce()
    expect(worker.listeners.has('fetch')).toBe(false)
  })

  it('renews from config without a page and retires the old endpoint after storing its replacement', async () => {
    const worker = loadWorker()
    await worker.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example.test/old' } })
    expect(worker.calls.map((call) => call.path)).toEqual([
      '/__dsh/web-push/config',
      '/__dsh/web-push/subscribe',
      '/__dsh/web-push/unsubscribe',
    ])
    expect(worker.calls[0].init).toEqual({ credentials: 'same-origin' })
    expect(worker.scope.registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([251, 255]),
    })
    expect(worker.calls[1]).toMatchObject({
      init: { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' } },
      body: { ...browserSubscription().toJSON(), previousEndpoint: 'https://push.example.test/old' },
    })
    expect(worker.calls[2].body).toEqual({ endpoint: 'https://push.example.test/old' })
  })

  it.each([
    ['https://push.example.test/old', ['/__dsh/web-push/subscribe', '/__dsh/web-push/unsubscribe']],
    ['https://push.example.test/new', ['/__dsh/web-push/subscribe']],
  ])('stores a browser-provided replacement for %s without resubscribing', async (endpoint, expectedPaths) => {
    const worker = loadWorker()
    await worker.fire('pushsubscriptionchange', {
      oldSubscription: { endpoint },
      newSubscription: browserSubscription(),
    })
    expect(worker.scope.registration.pushManager.subscribe).not.toHaveBeenCalled()
    expect(worker.calls.map((call) => call.path)).toEqual(expectedPaths)
    expect(worker.calls[0].body).toEqual({
      ...browserSubscription().toJSON(),
      previousEndpoint: endpoint,
    })
  })

  it.each([null, browserSubscription()])(
    'leaves registration to the user without a previous subscription: %j',
    async (newSubscription) => {
      const worker = loadWorker()
      await worker.fire('pushsubscriptionchange', { newSubscription })
      expect(worker.scope.registration.pushManager.subscribe).not.toHaveBeenCalled()
      expect(worker.calls).toEqual([])
    },
  )

  it.each(['config', 'browser subscription', 'storage'])(
    'keeps the old endpoint when renewal fails at %s',
    async (stage) => {
      const worker = loadWorker((path) =>
        (stage === 'config' && path.endsWith('/config')) || (stage === 'storage' && path.endsWith('/subscribe'))
          ? 500
          : 200,
      )
      if (stage === 'browser subscription') {
        worker.scope.registration.pushManager.subscribe.mockRejectedValue(new Error('subscription failed'))
      }
      await worker.fire('pushsubscriptionchange', { oldSubscription: { endpoint: 'https://push.example.test/old' } })
      expect(worker.calls.map((call) => call.path)).toEqual(
        stage === 'storage' ? ['/__dsh/web-push/config', '/__dsh/web-push/subscribe'] : ['/__dsh/web-push/config'],
      )
    },
  )
})

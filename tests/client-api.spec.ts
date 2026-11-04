import { applicationServerKey } from '../src/application-server-key.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadSubscription,
  refreshServiceWorker,
  renewSubscription,
  saveSuppression,
  subscriptionUsesApplicationServerKey,
  waitForActiveServiceWorker,
} from '../src/client/api.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'

const CONFIG = {
  publicKey: 'AQID',
  serviceWorkerUrl: '/sw.js',
  serviceWorkerScope: '/scope/',
  suppression: { suppressWhileActive: true, idleMinutes: 10 },
} as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('client Service Worker helpers', () => {
  it('waits for the registered worker to activate', async () => {
    let state: ServiceWorkerState = 'installing'
    let active: ServiceWorker | null = null
    let notify: (() => void) | undefined
    const worker = {
      get state() {
        return state
      },
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        notify = () => {
          if (typeof listener === 'function') listener(new Event('statechange'))
        }
      },
      removeEventListener() {},
    } as unknown as ServiceWorker
    const registration = {
      get active() {
        return active
      },
      installing: worker,
    } as unknown as ServiceWorkerRegistration

    const pending = waitForActiveServiceWorker(registration)
    state = 'activated'
    active = worker
    notify?.()

    await expect(pending).resolves.toBe(registration)
  })

  it('detects a subscription created with another VAPID key', () => {
    const subscription = {
      options: { applicationServerKey: applicationServerKey('AQID').buffer },
    } as PushSubscription
    expect(subscriptionUsesApplicationServerKey(subscription, 'AQID')).toBe(true)
    expect(subscriptionUsesApplicationServerKey(subscription, 'BAUG')).toBe(false)
  })

  it('reads the host preferences for a matching browser subscription', async () => {
    const subscription = {
      options: { applicationServerKey: applicationServerKey('AQID').buffer },
      toJSON: () => ({
        endpoint: 'https://push.example.test/one',
        expirationTime: null,
        keys: { p256dh: 'AQID', auth: 'BAUG' },
      }),
    } as unknown as PushSubscription
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockResolvedValue({
          pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) },
        }),
      },
    })
    const preferences = { ...DEFAULT_NOTIFICATION_PREFERENCES, bodyMode: 'summary' }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ preferences })))
    vi.stubGlobal('fetch', fetch)

    await expect(loadSubscription(CONFIG)).resolves.toEqual(preferences)
    expect(fetch).toHaveBeenCalledWith(
      '/__dsh/web-push/subscription',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      }),
    )
  })

  it('replaces even a matching subscription when the user enables notifications', async () => {
    const steps: string[] = []
    const existing = {
      endpoint: 'https://push.example.test/old',
      options: { applicationServerKey: applicationServerKey(CONFIG.publicKey).buffer },
      unsubscribe: async () => {
        steps.push('unsubscribe in browser')
        return true
      },
    }
    const renewed = { endpoint: 'https://push.example.test/new', keys: { p256dh: 'AQID', auth: 'BAUG' } }
    const subscribe = vi.fn(async () => {
      steps.push('subscribe in browser')
      return { toJSON: () => renewed }
    })
    const register = vi.fn(async () => ({
      active: {},
      pushManager: { getSubscription: async () => existing, subscribe },
    }))
    vi.stubGlobal('navigator', { serviceWorker: { register } })
    const fetch = vi.fn(async (url: string) => {
      steps.push(url)
      return new Response('{}')
    })
    vi.stubGlobal('fetch', fetch)

    await renewSubscription(CONFIG)

    expect(register).toHaveBeenCalledWith(CONFIG.serviceWorkerUrl, { scope: CONFIG.serviceWorkerScope })
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: applicationServerKey(CONFIG.publicKey),
    })
    expect(steps).toEqual([
      '/__dsh/web-push/unsubscribe',
      'unsubscribe in browser',
      'subscribe in browser',
      '/__dsh/web-push/subscribe',
    ])
    expect(fetch).toHaveBeenLastCalledWith(
      '/__dsh/web-push/subscribe',
      expect.objectContaining({ body: JSON.stringify({ ...renewed, preferences: DEFAULT_NOTIFICATION_PREFERENCES }) }),
    )
  })

  it('posts the suppression policy and returns what the server kept', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ suppressWhileActive: false, idleMinutes: 2 }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await expect(saveSuppression({ suppressWhileActive: false, idleMinutes: 2 })).resolves.toEqual({
      suppressWhileActive: false,
      idleMinutes: 2,
    })
    expect(fetch).toHaveBeenCalledWith(
      '/__dsh/web-push/settings',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ suppressWhileActive: false, idleMinutes: 2 }),
      }),
    )
  })

  it('re-fetches the worker for its own scope when the section opens', async () => {
    const update = vi.fn().mockResolvedValue(undefined)
    const getRegistration = vi.fn().mockResolvedValue({ update })
    vi.stubGlobal('navigator', { serviceWorker: { getRegistration } })

    await expect(refreshServiceWorker(CONFIG)).resolves.toBeUndefined()
    expect(getRegistration).toHaveBeenCalledWith('/scope/')
    expect(update).toHaveBeenCalledTimes(1)
  })

  it('keeps the installed worker when the update check fails', async () => {
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: vi.fn().mockRejectedValue(new Error('offline')),
      },
    })

    await expect(refreshServiceWorker(CONFIG)).resolves.toBeUndefined()
  })
})

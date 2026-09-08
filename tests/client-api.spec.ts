import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applicationServerKey,
  reconcileSubscription,
  subscriptionUsesApplicationServerKey,
  waitForActiveServiceWorker,
} from '../src/client/api.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'

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

  it('restores a matching browser subscription to the host', async () => {
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
    const fetch = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetch)

    await expect(
      reconcileSubscription(
        {
          publicKey: 'AQID',
          serviceWorkerUrl: '/sw.js',
          serviceWorkerScope: '/scope/',
        },
        DEFAULT_NOTIFICATION_PREFERENCES,
      ),
    ).resolves.toBe('registered')
    expect(fetch).toHaveBeenCalledWith('/__dsh/web-push/subscribe', expect.objectContaining({ method: 'POST' }))
  })
})

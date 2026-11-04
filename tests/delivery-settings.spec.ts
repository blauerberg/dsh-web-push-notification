import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PushStore } from '../src/store.ts'
import { createPushRoutes } from '../src/routes.ts'
import { PresenceRegistry } from '../src/presence.ts'
import { applicationServerKey } from '../src/application-server-key.ts'
import { checkbox, renderSettings } from './client.ts'
import { subscriptionFixture, vapidKeys } from './fixtures.ts'
import { request, response } from './http.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button',
  StateDot: 'span',
  IconChevronDownOutlineRegular: 'span',
}))

let root: string | undefined
let panel: ReactTestRenderer | undefined
afterEach(() => {
  act(() => panel?.unmount())
  panel = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

const subscription = subscriptionFixture('https://push.example.test/review-device', { bodyMode: 'summary' })

it.each([false, true])(
  'keeps the current device registration accurate after Send test (current expired: %s)',
  async (currentExpired) => {
    root = mkdtempSync(join(tmpdir(), 'push-removal-'))
    const store = PushStore.open(join(root, 'state.json'), () => vapidKeys)
    store.upsert(subscription)
    const otherEndpoint = 'https://push.example.test/other-device'
    store.upsert({ ...subscription, endpoint: otherEndpoint })
    const routes = createPushRoutes({
      store,
      presence: new PresenceRegistry(),
      maxRequestBodyBytes: 1024,
      requestRejection: () => undefined,
      sender: {
        send: async (device) => {
          if (device.endpoint === (currentExpired ? subscription.endpoint : otherEndpoint)) {
            throw Object.assign(new Error('expired endpoint'), { statusCode: 410 })
          }
        },
      },
    })
    const browserSubscription = {
      endpoint: subscription.endpoint,
      options: { applicationServerKey: applicationServerKey('AQID').buffer },
      toJSON: () => subscription,
    }
    vi.stubGlobal('window', { isSecureContext: true, PushManager: {} })
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(subscription.preferences) })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => ({
          update: async () => {},
          pushManager: { getSubscription: async () => browserSubscription },
        }),
      },
    })
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      requests.push(url)
      const route = routes.find((route) => route.path === url)
      if (route === undefined) throw new Error(`unexpected request ${url}`)
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
      const result = response()
      await route.handler(request(init?.method ?? 'GET', body), result.response)
      return new Response(String(result.raw), { status: result.status })
    })
    const mounted = await renderSettings()
    panel = mounted
    expect(checkbox(mounted, 'Enabled').props.checked).toBe(true)
    expect(mounted.root.findByType('button').props.disabled).toBe(false)
    requests.length = 0
    await act(async () => {
      mounted.root.findByType('button').props.onClick()
    })
    expect(requests).toEqual(['/__dsh/web-push/config', '/__dsh/web-push/test'])
    expect(store.list().map((item) => item.endpoint)).toEqual([currentExpired ? otherEndpoint : subscription.endpoint])
    expect(checkbox(mounted, 'Enabled').props.checked).toBe(!currentExpired)
    expect(mounted.root.findByType('button').props.disabled).toBe(currentExpired)
    const message = mounted.root.findByProps({ 'aria-live': 'polite' }).children.join('')
    expect(message).toContain(currentExpired ? 'This device is not registered' : 'affected device')
  },
)

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { legacyStoragePaths } from '../src/index.ts'
import { PushStore } from '../src/store.ts'
import { createPushRoutes } from '../src/routes.ts'
import { PresenceRegistry } from '../src/presence.ts'
import { applicationServerKey } from '../src/client/api.ts'
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
const previousHome = process.env.DSH_HOME
afterEach(() => {
  act(() => panel?.unmount())
  panel = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  vi.unstubAllGlobals()
})

const subscription = subscriptionFixture('https://push.example.test/review-device', { bodyMode: 'summary' })

it('preserves the profile-owned keys and device when a newer shared file has unrelated keys', () => {
  root = mkdtempSync(join(tmpdir(), 'push-migration-review-'))
  process.env.DSH_HOME = join(root, 'home')
  const profile = join(root, 'home', 'profiles', 'web')
  const owned = join(profile, 'web-push.json')
  const shared = join(root, 'home', 'web-push', 'state.json')
  const ownedKeys = { publicKey: 'AQID', privateKey: 'BAUG' }
  const sharedKeys = { publicKey: 'BwgJ', privateKey: 'CgsM' }
  for (const [path, keys, devices] of [
    [owned, ownedKeys, [subscription]],
    [shared, sharedKeys, []],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, vapid: keys, subscriptions: devices }))
  }
  utimesSync(owned, 1, 1)
  utimesSync(shared, 2, 2)
  const ctx = new Context().extend({ baseUrl: `${pathToFileURL(profile).href}/` })
  ctx.provide('profileContext', { dir: profile })
  const store = PushStore.open(join(profile, 'web-push', 'state.json'), () => ownedKeys, legacyStoragePaths(ctx))
  expect({ publicKey: store.publicKey, endpoints: store.list().map((item) => item.endpoint) }).toEqual({
    publicKey: ownedKeys.publicKey,
    endpoints: [subscription.endpoint],
  })
})

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

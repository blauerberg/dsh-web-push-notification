import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { legacyStoragePaths } from '../src/index.ts'
import { PushStore } from '../src/store.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'
import { createPushRoutes } from '../src/routes.ts'
import { PresenceRegistry } from '../src/presence.ts'
import { applicationServerKey } from '../src/client/api.ts'
import { WebPushSettingsSection } from '../src/client/WebPushSettingsSection.tsx'

const hooks = vi.hoisted(() => ({
  index: 0,
  changes: [] as Array<{ index: number; value: unknown }>,
}))

vi.mock('react', async (importOriginal) => {
  const original = await importOriginal<typeof import('react')>()
  return {
    ...original,
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useState: (initial: unknown) => {
      const index = hooks.index++
      const value = index === 0 ? 'subscribed' : typeof initial === 'function' ? initial() : initial
      return [value, (next: unknown) => hooks.changes.push({ index, value: next })]
    },
  }
})

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button',
  StateDot: 'span',
  IconChevronDownOutlineRegular: 'span',
}))

let root: string | undefined
const previousHome = process.env.DSH_HOME
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  hooks.index = 0
  hooks.changes.length = 0
  vi.unstubAllGlobals()
})

const subscription = {
  endpoint: 'https://push.example.test/review-device',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, bodyMode: 'summary' as const },
}

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

function testClick(value: unknown): (() => void) | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = testClick(item)
      if (found !== undefined) return found
    }
  }
  if (typeof value !== 'object' || value === null || !('props' in value)) return undefined
  const props = value.props
  if (typeof props !== 'object' || props === null) return undefined
  if (
    'children' in props &&
    props.children === 'Send test' &&
    'onClick' in props &&
    typeof props.onClick === 'function'
  ) {
    const click = props.onClick
    return () => click()
  }
  return 'children' in props ? testClick(props.children) : undefined
}

it.each([false, true])(
  'keeps the current device registration accurate after Send test (current expired: %s)',
  async (currentExpired) => {
    root = mkdtempSync(join(tmpdir(), 'push-removal-'))
    const store = PushStore.open(join(root, 'state.json'), () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
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
      const raw = typeof init?.body === 'string' ? init.body : ''
      let status = 0
      let body = ''
      await route.handler(
        {
          method: init?.method ?? 'GET',
          headers: { 'content-type': 'application/json' },
          async *[Symbol.asyncIterator]() {
            if (raw !== '') yield Buffer.from(raw)
          },
        } as never,
        {
          writeHead(code: number) {
            status = code
          },
          end(value: string) {
            body = value
          },
        } as never,
      )
      return new Response(body, { status })
    })
    const click = testClick(WebPushSettingsSection({} as never))
    expect(click).toBeDefined()
    click?.()
    await vi.waitFor(() =>
      expect(hooks.changes.some((change) => change.index === 1 && change.value === false)).toBe(true),
    )
    expect(requests).toEqual(['/__dsh/web-push/config', '/__dsh/web-push/test'])
    expect(store.list().map((item) => item.endpoint)).toEqual([currentExpired ? otherEndpoint : subscription.endpoint])
    expect(hooks.changes.filter((change) => change.index === 0).map((change) => change.value)).toEqual(
      currentExpired ? ['granted'] : [],
    )
    const message = hooks.changes.findLast((change) => change.index === 2)?.value
    expect(message).toContain(currentExpired ? 'This device is not registered' : 'affected device')
  },
)

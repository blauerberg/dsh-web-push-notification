import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { PushStore } from '../src/store.ts'
import { createPushRoutes } from '../src/routes.ts'
import { PresenceRegistry } from '../src/presence.ts'
import { applicationServerKey } from '../src/application-server-key.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'
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

const subscription = subscriptionFixture('https://push.example.test/review-device', {
  bodyMode: 'summary',
  turnCompleted: false,
})
const otherEndpoint = 'https://push.example.test/other-device'

function setup(registered = true, expiredEndpoint?: string) {
  root = mkdtempSync(join(tmpdir(), 'push-settings-'))
  const store = PushStore.open(join(root, 'state.json'), () => vapidKeys)
  if (registered) store.upsert(subscription)
  store.upsert({ ...subscription, endpoint: otherEndpoint })
  const routes = createPushRoutes({
    store,
    presence: new PresenceRegistry(),
    maxRequestBodyBytes: 1024,
    requestRejection: () => undefined,
    sender: {
      send: async (device) => {
        if (device.endpoint === expiredEndpoint) throw Object.assign(new Error('expired endpoint'), { statusCode: 410 })
      },
    },
  })
  const browserSubscription = {
    endpoint: subscription.endpoint,
    options: { applicationServerKey: applicationServerKey('AQID').buffer },
    toJSON: () => ({ endpoint: subscription.endpoint, keys: subscription.keys }),
    unsubscribe: async () => {
      current = null
      return true
    },
  }
  let current: typeof browserSubscription | null = browserSubscription
  const registration = {
    active: {},
    update: async () => {},
    pushManager: {
      getSubscription: async () => current,
      subscribe: async () => {
        current = browserSubscription
        return current
      },
    },
  }
  const storage = {
    getItem: vi.fn(() => {
      throw new Error('browser storage unavailable')
    }),
    setItem: vi.fn(),
  }
  vi.stubGlobal('window', { isSecureContext: true, PushManager: {} })
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('navigator', {
    serviceWorker: {
      getRegistration: async () => registration,
      register: async () => registration,
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
  return { store, storage, requests }
}

async function mount() {
  panel = await renderSettings()
  return panel
}

it('loads the host preferences without resetting them when browser storage is unavailable', async () => {
  const { store, storage } = setup()
  const mounted = await mount()
  expect(store.preferencesOf(subscription.endpoint)).toEqual(subscription.preferences)
  expect(mounted.root.findByProps({ 'aria-label': 'Notification body' }).props.value).toBe('summary')
  expect(checkbox(mounted, 'Task completed').props.checked).toBe(false)
  expect(storage.getItem).not.toHaveBeenCalled()
  expect(storage.setItem).not.toHaveBeenCalled()
})

it('leaves a missing host registration disabled until the user enables it', async () => {
  const { store, requests } = setup(false)
  const mounted = await mount()
  expect(checkbox(mounted, 'Enabled').props.checked).toBe(false)
  expect(store.preferencesOf(subscription.endpoint)).toBeUndefined()
  expect(requests).not.toContain('/__dsh/web-push/subscribe')
  await act(async () => checkbox(mounted, 'Enabled').props.onChange({ currentTarget: { checked: true } }))
  expect(checkbox(mounted, 'Enabled').props.checked).toBe(true)
  expect(store.preferencesOf(subscription.endpoint)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
})

it('discards this device preferences on disable and starts with defaults when enabled again', async () => {
  const { store } = setup()
  const mounted = await mount()
  await act(async () => {
    checkbox(mounted, 'Response required').props.onChange({ currentTarget: { checked: false } })
  })
  expect(store.preferencesOf(subscription.endpoint)?.question).toBe(false)
  await act(async () => checkbox(mounted, 'Enabled').props.onChange({ currentTarget: { checked: false } }))
  expect(store.preferencesOf(subscription.endpoint)).toBeUndefined()
  expect(checkbox(mounted, 'Enabled').props.checked).toBe(false)
  await act(async () => checkbox(mounted, 'Enabled').props.onChange({ currentTarget: { checked: true } }))
  expect(store.preferencesOf(subscription.endpoint)).toEqual(DEFAULT_NOTIFICATION_PREFERENCES)
  expect(store.preferencesOf(otherEndpoint)).toEqual(subscription.preferences)
})

it('requires enable again if the host loses the registration while the panel is open', async () => {
  const { store } = setup()
  const mounted = await mount()
  store.remove(subscription.endpoint)
  await act(async () => {
    checkbox(mounted, 'Response required').props.onChange({ currentTarget: { checked: false } })
  })
  expect(store.preferencesOf(subscription.endpoint)).toBeUndefined()
  expect(checkbox(mounted, 'Enabled').props.checked).toBe(false)
})

it.each([false, true])(
  'keeps the current device registration accurate after Send test (current expired: %s)',
  async (currentExpired) => {
    const { store, requests } = setup(true, currentExpired ? subscription.endpoint : otherEndpoint)
    const mounted = await mount()
    expect(checkbox(mounted, 'Enabled').props.checked).toBe(true)
    expect(mounted.root.findByType('button').props.disabled).toBe(false)
    requests.length = 0
    await act(async () => mounted.root.findByType('button').props.onClick())
    expect(requests).toEqual(['/__dsh/web-push/config', '/__dsh/web-push/test'])
    expect(store.list().map((item) => item.endpoint)).toEqual([currentExpired ? otherEndpoint : subscription.endpoint])
    expect(checkbox(mounted, 'Enabled').props.checked).toBe(!currentExpired)
    expect(mounted.root.findByType('button').props.disabled).toBe(currentExpired)
    const message = mounted.root.findByProps({ 'aria-live': 'polite' }).children.join('')
    expect(message).toContain(currentExpired ? 'This device is not registered' : 'affected device')
  },
)

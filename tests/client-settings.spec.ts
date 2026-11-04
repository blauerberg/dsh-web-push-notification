import { act, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { applicationServerKey } from '../src/application-server-key.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'
import { subscriptionFixture } from './fixtures.ts'
import { checkbox, renderSettings } from './client.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: 'button',
  StateDot: 'span',
  IconChevronDownOutlineRegular: 'span',
}))

const config = {
  publicKey: 'AQID',
  serviceWorkerUrl: '/__dsh/web-push/sw.js',
  serviceWorkerScope: '/__dsh/web-push/',
  suppression: { suppressWhileActive: true, idleMinutes: 2 },
}

let panel: ReactTestRenderer | undefined
afterEach(() => {
  act(() => panel?.unmount())
  panel = undefined
  vi.unstubAllGlobals()
})

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

async function mount() {
  const mounted = await renderSettings()
  panel = mounted
  return mounted
}

function browser(subscribed = false, permission: NotificationPermission = 'granted') {
  const record = subscriptionFixture()
  const subscription = {
    ...record,
    options: { applicationServerKey: applicationServerKey(config.publicKey).buffer },
    toJSON: () => record,
    unsubscribe: vi.fn(async (): Promise<boolean> => {
      current = null
      return true
    }),
  }
  let current: typeof subscription | null = subscribed ? subscription : null
  const registration = {
    active: {},
    update: vi.fn(async () => {}),
    pushManager: {
      getSubscription: vi.fn(async () => current),
      subscribe: vi.fn(async () => {
        current = subscription
        return subscription
      }),
    },
  }
  const notification = {
    permission,
    requestPermission: vi.fn(async (): Promise<NotificationPermission> => {
      notification.permission = 'granted'
      return 'granted'
    }),
  }
  const serviceWorker = {
    register: vi.fn(async () => registration),
    getRegistration: vi.fn(async () => registration),
  }
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    switch (url) {
      case '/__dsh/web-push/config':
        return new Response(JSON.stringify(config))
      case '/__dsh/web-push/subscription':
        return new Response(JSON.stringify({ preferences: DEFAULT_NOTIFICATION_PREFERENCES }))
      case '/__dsh/web-push/subscribe':
      case '/__dsh/web-push/unsubscribe':
        return new Response('{}')
      case '/__dsh/web-push/settings':
        return new Response(String(init?.body))
      default:
        throw new Error(`Unexpected request: ${url}`)
    }
  })
  vi.stubGlobal('window', { isSecureContext: true, PushManager: {} })
  vi.stubGlobal('Notification', notification)
  vi.stubGlobal('navigator', { serviceWorker })
  vi.stubGlobal('fetch', fetch)
  return { fetch, subscription, registration, serviceWorker, notification }
}

it('restores timing controls when enabling succeeds after the initial config request fails', async () => {
  browser().fetch.mockRejectedValueOnce(new Error('Config unavailable'))
  const mounted = await mount()
  expect(mounted.root.findByProps({ 'aria-live': 'polite' }).children).toEqual(['Config unavailable'])
  expect(mounted.root.findByProps({ 'aria-label': 'Away after' }).props.disabled).toBe(true)

  await act(async () => {
    checkbox(mounted, 'Enabled').props.onChange({ currentTarget: { checked: true } })
  })

  expect(checkbox(mounted, 'Enabled').props.checked).toBe(true)
  expect(mounted.root.findByProps({ 'aria-label': 'Away after' }).props.disabled).toBe(false)
  expect(mounted.root.findByProps({ 'aria-label': 'Away after' }).props.value).toBe(2)
})

it('requests permission during the enable gesture before fetching config', async () => {
  const setup = browser(false, 'default')
  const permission = deferred<NotificationPermission>()
  setup.notification.requestPermission.mockReturnValue(permission.promise)
  const mounted = await mount()
  setup.fetch.mockClear()

  act(() => {
    checkbox(mounted, 'Enabled').props.onChange({ currentTarget: { checked: true } })
    expect(setup.notification.requestPermission).toHaveBeenCalledOnce()
    expect(setup.fetch).not.toHaveBeenCalled()
  })
  await act(async () => {
    setup.notification.permission = 'granted'
    permission.resolve('granted')
  })

  expect(checkbox(mounted, 'Enabled').props.checked).toBe(true)
})

it.each([false, true])('applies a preference only after a successful save (rejected: %s)', async (rejected) => {
  const setup = browser(true)
  const mounted = await mount()
  const response = deferred<Response>()
  setup.fetch.mockResolvedValueOnce(new Response(JSON.stringify(config))).mockReturnValueOnce(response.promise)
  const body = () => mounted.root.findByProps({ 'aria-label': 'Notification body' })

  await act(async () => {
    body().props.onChange({ currentTarget: { value: 'summary' } })
  })
  expect(body().props.value).toBe('full')
  expect(body().props.disabled).toBe(true)

  await act(async () => {
    if (rejected) response.reject(new Error('Preferences rejected'))
    else
      response.resolve(
        new Response(JSON.stringify({ preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, bodyMode: 'summary' } })),
      )
  })

  expect(body().props.value).toBe(rejected ? 'full' : 'summary')
  expect(body().props.disabled).toBe(false)
  expect(mounted.root.findByProps({ 'aria-live': 'polite' }).children).toEqual([
    rejected ? 'Preferences rejected' : 'Notification preferences saved.',
  ])
})

it('shows the server timing value and keeps it if a later save fails', async () => {
  const setup = browser()
  const mounted = await mount()
  const timing = () => mounted.root.findByProps({ 'aria-label': 'Away after' })
  setup.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ suppressWhileActive: true, idleMinutes: 15 })))

  await act(async () => timing().props.onChange({ currentTarget: { value: '5' } }))
  expect(timing().props.value).toBe(15)
  setup.fetch.mockRejectedValueOnce(new Error('Timing rejected'))
  await act(async () => timing().props.onChange({ currentTarget: { value: '30' } }))

  expect(timing().props.value).toBe(15)
  expect(timing().props.disabled).toBe(false)
  expect(mounted.root.findByProps({ 'aria-live': 'polite' }).children).toEqual(['Timing rejected'])
})

it.each(['config', 'worker update', 'subscription lookup'] as const)(
  'stops a disposed refresh after its pending %s resolves',
  async (stage) => {
    const setup = browser(true)
    const pending = deferred<void>()
    if (stage === 'config') {
      setup.fetch.mockImplementationOnce(async () => {
        await pending.promise
        return new Response(JSON.stringify(config))
      })
    } else if (stage === 'worker update') setup.registration.update.mockReturnValueOnce(pending.promise)
    else {
      setup.registration.pushManager.getSubscription.mockImplementationOnce(async () => {
        await pending.promise
        return setup.subscription
      })
    }
    const previous = await mount()
    act(() => previous.unmount())
    const mounted = await mount()
    await act(async () => checkbox(mounted, 'Enabled').props.onChange({ currentTarget: { checked: false } }))
    const calls = () => [
      setup.fetch.mock.calls.length,
      setup.registration.update.mock.calls.length,
      setup.registration.pushManager.getSubscription.mock.calls.length,
    ]
    const before = calls()

    await act(async () => pending.resolve())

    expect(calls()).toEqual(before)
    expect(checkbox(mounted, 'Enabled').props.checked).toBe(false)
  },
)

it('does not overwrite a reopened panel when an earlier preference save fails', async () => {
  const setup = browser(true)
  const previous = await mount()
  const response = deferred<Response>()
  setup.fetch.mockResolvedValueOnce(new Response(JSON.stringify(config))).mockReturnValueOnce(response.promise)
  await act(async () => {
    previous.root
      .findByProps({ 'aria-label': 'Notification body' })
      .props.onChange({ currentTarget: { value: 'summary' } })
  })
  act(() => previous.unmount())
  const mounted = await mount()

  await act(async () => response.reject(new Error('Earlier save failed')))

  expect(mounted.root.findByProps({ 'aria-label': 'Notification body' }).props.value).toBe('full')
  expect(mounted.root.findAllByProps({ 'aria-live': 'polite' })).toHaveLength(0)
})

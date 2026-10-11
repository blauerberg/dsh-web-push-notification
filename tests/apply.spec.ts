import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, Config, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_VAPID_SUBJECT } from '../src/index.ts'
import { PushStore } from '../src/store.ts'

const webPush = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'AQID', privateKey: 'BAUG' })),
  sendNotification: vi.fn(async () => ({})),
  setVapidDetails: vi.fn(),
}))

vi.mock('web-push', () => ({ default: webPush }))

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  vi.clearAllMocks()
})

describe('host plugin registration', () => {
  it('registers every route and returns their disposers through the effect', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const routes: Array<{ path: string }> = []
    const disposers: Array<() => void> = []
    const ctx = {
      baseUrl: `${pathToFileURL(root).href}/`,
      connection: { requestRejection: () => undefined },
      webServer: {
        register(route: { path: string }) {
          routes.push(route)
          return () => {
            routes.splice(routes.indexOf(route), 1)
          }
        },
      },
      logger: { warn: vi.fn() },
      on() {
        return () => {}
      },
      effect(factory: () => (() => void) | undefined) {
        const dispose = factory()
        if (dispose !== undefined) disposers.push(dispose)
      },
    }
    apply(ctx as never, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath: join(root, 'state.json'),
      maxRequestBodyBytes: 1024,
    })
    expect(existsSync(join(root, 'state.json'))).toBe(true)
    expect(routes.map((route) => route.path)).toEqual([
      '/__dsh/web-push/config',
      '/__dsh/web-push/sw.js',
      '/__dsh/web-push/notification-icon.png',
      '/__dsh/web-push/notification-badge.png',
      '/__dsh/web-push/subscribe',
      '/__dsh/web-push/unsubscribe',
      '/__dsh/web-push/presence',
      '/__dsh/web-push/settings',
      '/__dsh/web-push/test',
    ])
    for (const dispose of disposers) dispose()
    expect(routes).toEqual([])
  })

  it('keeps each profile\u2019s state inside that profile\u2019s directory', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'home')
    try {
      const stateFor = (profile: string): string => {
        const dir = join(root, 'profiles', profile)
        mkdirSync(dir, { recursive: true })
        const ctx = {
          baseUrl: `${pathToFileURL(dir).href}/`,
          get(name: string) {
            return name === 'profileContext' ? { name: profile, dir } : undefined
          },
          connection: { requestRejection: () => undefined },
          webServer: { register: () => () => {} },
          logger: { info: vi.fn(), warn: vi.fn() },
          on() {
            return () => {}
          },
          effect(factory: () => (() => void) | undefined) {
            factory()
          },
        }
        apply(ctx as never, { vapidSubject: 'mailto:test@example.invalid', maxRequestBodyBytes: 1024 })
        return join(dir, 'web-push', 'state.json')
      }

      const web = stateFor('web')
      const webSafe = stateFor('web-safe')
      expect(existsSync(web)).toBe(true)
      expect(existsSync(webSafe)).toBe(true)
      // Two profiles share one Harness home; a single shared file would let the
      // second profile push its sessions at the first one's browser and overwrite
      // its subscription list on every write.
      expect(web).not.toBe(webSafe)
      expect(existsSync(dshHomePath('web-push', 'state.json'))).toBe(false)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('inherits the key pair a deployment kept at the Harness home before it ran in a profile', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'home')
    try {
      // What a run outside any profile left behind: the deployment's push
      // identity, plus a device that may belong to another profile.
      const shared = join(root, 'home', 'web-push')
      mkdirSync(shared, { recursive: true })
      writeFileSync(
        join(shared, 'state.json'),
        JSON.stringify({
          version: 1,
          vapid: { publicKey: 'SHAREDKEY', privateKey: 'SHAREDBAUG' },
          subscriptions: [
            {
              endpoint: 'https://fcm.googleapis.com/fcm/send/another-profile',
              expirationTime: null,
              keys: { p256dh: 'p', auth: 'a' },
              preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true, bodyMode: 'full' },
            },
          ],
        }),
      )

      const dir = join(root, 'profiles', 'web')
      mkdirSync(dir, { recursive: true })
      const ctx = {
        baseUrl: `${pathToFileURL(dir).href}/`,
        get(name: string) {
          return name === 'profileContext' ? { name: 'web', dir } : undefined
        },
        connection: { requestRejection: () => undefined },
        webServer: { register: () => () => {} },
        logger: { info: vi.fn(), warn: vi.fn() },
        on() {
          return () => {}
        },
        effect(factory: () => (() => void) | undefined) {
          factory()
        },
      }
      apply(ctx as never, { vapidSubject: 'mailto:test@example.invalid', maxRequestBodyBytes: 1024 })

      const persisted = JSON.parse(readFileSync(join(dir, 'web-push', 'state.json'), 'utf8')) as {
        vapid: { publicKey: string }
        subscriptions: unknown[]
      }
      // A browser subscription is bound to the pair that created it, so a move to
      // the per-profile path carries the pair along instead of minting a second
      // one and orphaning every device the deployment had.
      expect(persisted.vapid.publicKey).toBe('SHAREDKEY')
      expect(webPush.generateVAPIDKeys).not.toHaveBeenCalled()
      // The device list stays behind: every profile used to write to that file.
      expect(persisted.subscriptions).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('delivers an event to eligible subscriptions and contains one send failure', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription('https://push.example.test/full', 'full', true))
    store.upsert(subscription('https://push.example.test/summary', 'summary', true))
    store.upsert(subscription('https://push.example.test/disabled', 'full', false))
    webPush.sendNotification.mockImplementation(async (value) => {
      if (value.endpoint.endsWith('/full')) throw new Error('network down')
      return {}
    })
    let onSessionEvent: ((session: Session, event: SessionEvent) => void) | undefined
    const warn = vi.fn()
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: { register: () => () => {} },
      logger: { warn },
      on(name: string, listener: (session: Session, event: SessionEvent) => void) {
        if (name === 'session/event') onSessionEvent = listener
        return () => {}
      },
      effect(factory: () => (() => void) | undefined) {
        factory()
      },
    }
    apply(ctx as never, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const assistant = event({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'The answer.' }] } },
    })
    const end = event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    onSessionEvent?.({ id: 'session-1', header: {}, snapshotEvents: () => [assistant, end] } as Session, end)

    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(2)
    })
    const bodies = webPush.sendNotification.mock.calls.map(
      ([, payload]) => (JSON.parse(String(payload)) as { body: string }).body,
    )
    expect(bodies).toEqual(['The answer.', 'Turn 1 completed.'])
    expect(warn).toHaveBeenCalledTimes(1)
    // A short TTL is what drops a notification while the phone is asleep.
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ TTL: 86_400 }),
    )
    // The Push service receives the per-message hints as well: a finished turn
    // waits for the next wake-up, and a session's news replaces itself in the
    // queue instead of arriving as a backlog.
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ urgency: 'normal', topic: expect.stringMatching(/^[A-Za-z0-9_-]{1,32}$/) }),
    )
  })

  it('sends nothing while a page is in focus, and resumes once no page is', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription('https://push.example.test/full', 'full', true))
    const registered: RouteCapture[] = []
    let onSessionEvent: ((session: Session, event: SessionEvent) => void) | undefined
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: {
        register(route: RouteCapture) {
          registered.push(route)
          return () => {}
        },
      },
      logger: { warn: vi.fn() },
      on(name: string, listener: (session: Session, event: SessionEvent) => void) {
        if (name === 'session/event') onSessionEvent = listener
        return () => {}
      },
      effect(factory: () => (() => void) | undefined) {
        factory()
      },
    }
    apply(ctx as never, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const presenceRoute = registered.find((route) => route.path === '/__dsh/web-push/presence')
    const assistant = event({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'The answer.' }] } },
    })
    const end = event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const session = { id: 'session-1', header: {}, snapshotEvents: () => [assistant, end] } as Session

    expect((await reportPresence(presenceRoute, { id: 'desktop-page', active: true })).status).toBe(200)
    onSessionEvent?.(session, end)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(webPush.sendNotification).not.toHaveBeenCalled()

    expect((await reportPresence(presenceRoute, { id: 'desktop-page', active: false })).status).toBe(200)
    onSessionEvent?.(session, end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps delivering while a page is in focus once the quiet period is switched off', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    // The operator's own choice in Settings, read back from storage on boot.
    store.setSettings({ suppressWhileActive: false, idleMinutes: 10 })
    store.upsert(subscription('https://push.example.test/full', 'full', true))
    const registered: RouteCapture[] = []
    let onSessionEvent: ((session: Session, event: SessionEvent) => void) | undefined
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: {
        register(route: RouteCapture) {
          registered.push(route)
          return () => {}
        },
      },
      logger: { warn: vi.fn() },
      on(name: string, listener: (session: Session, event: SessionEvent) => void) {
        if (name === 'session/event') onSessionEvent = listener
        return () => {}
      },
      effect(factory: () => (() => void) | undefined) {
        factory()
      },
    }
    apply(ctx as never, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const presenceRoute = registered.find((route) => route.path === '/__dsh/web-push/presence')
    const assistant = event({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'The answer.' }] } },
    })
    const end = event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    const session = { id: 'session-1', header: {}, snapshotEvents: () => [assistant, end] } as Session

    expect((await reportPresence(presenceRoute, { id: 'desktop-page', active: true })).status).toBe(200)
    onSessionEvent?.(session, end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
    })
  })

  it("keeps a subagent's own turn quiet unless a device asks for it", async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => ({ publicKey: 'AQID', privateKey: 'BAUG' }))
    store.upsert(subscription('https://push.example.test/quiet', 'full', true))
    store.upsert(subscription('https://push.example.test/asks', 'full', true, true))
    let onSessionEvent: ((session: Session, event: SessionEvent) => void) | undefined
    const ctx = {
      connection: { requestRejection: () => undefined },
      webServer: { register: () => () => {} },
      logger: { warn: vi.fn() },
      on(name: string, listener: (session: Session, event: SessionEvent) => void) {
        if (name === 'session/event') onSessionEvent = listener
        return () => {}
      },
      effect(factory: () => (() => void) | undefined) {
        factory()
      },
    }
    apply(ctx as never, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const assistant = event({
      type: 'assistant/message',
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Found it.' }] } },
    })
    const end = event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

    // A subagent runs in a session whose header says so; the dispatching session
    // reports the same work, so only the device that asked hears about the child.
    const child = {
      id: 'session-child',
      header: { origin: 'subagent' },
      snapshotEvents: () => [assistant, end],
    } as unknown as Session
    onSessionEvent?.(child, end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
    })
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example.test/asks' }),
      expect.any(String),
      expect.anything(),
    )

    // A top-level session still reaches every device that enabled the kind.
    const parent = {
      id: 'session-parent',
      header: {},
      snapshotEvents: () => [assistant, end],
    } as unknown as Session
    onSessionEvent?.(parent, end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(3)
    })
  })

  it('boots with documented defaults when the profile configures nothing', () => {
    // No field is required, so a profile with no config block cannot fail boot.
    expect(Config({})).toMatchObject({
      vapidSubject: DEFAULT_VAPID_SUBJECT,
      maxRequestBodyBytes: DEFAULT_MAX_REQUEST_BODY_BYTES,
    })
  })

  it('falls back to the Harness home outside a profile, and adopts the legacy file it finds', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
    const packageBase = mkdtempSync(join(tmpdir(), 'dsh-web-push-pkg-'))
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      // What 0.1.1 kept beside its bundle.
      const legacyPath = join(packageBase, 'web-push.json')
      writeFileSync(
        legacyPath,
        JSON.stringify({ version: 1, vapid: { publicKey: 'LEGACYKEY', privateKey: 'BAUG' }, subscriptions: [] }),
      )
      const ctx = {
        baseUrl: `${pathToFileURL(packageBase).href}/`,
        get() {
          return undefined
        },
        connection: { requestRejection: () => undefined },
        webServer: { register: () => () => {} },
        logger: { info: vi.fn(), warn: vi.fn() },
        on() {
          return () => {}
        },
        effect(factory: () => (() => void) | undefined) {
          factory()
        },
      }
      apply(ctx as never, {
        vapidSubject: 'mailto:test@example.invalid',
        maxRequestBodyBytes: 1024,
      })
      // No profile service means no per-profile location, so the shared path
      // under the Harness home stays as the fallback.
      const statePath = join(root, 'web-push', 'state.json')
      expect(existsSync(statePath)).toBe(true)
      const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { vapid: { publicKey: string } }
      // The key the browser's subscription was minted against comes along,
      // instead of being rotated away into a device that never rings again.
      expect(persisted.vapid.publicKey).toBe('LEGACYKEY')
      expect(existsSync(legacyPath)).toBe(true)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      rmSync(packageBase, { recursive: true, force: true })
    }
  })
})

function subscription(endpoint: string, bodyMode: 'full' | 'summary', turnCompleted: boolean, subagentRuns = false) {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: 'AQID', auth: 'BAUG' },
    preferences: { turnCompleted, turnFailed: true, approval: true, question: true, subagentRuns, bodyMode },
  }
}

function event(value: unknown): SessionEvent {
  return value as SessionEvent
}

interface RouteCapture {
  readonly path: string
  readonly handler: (req: never, res: never) => unknown
}

async function reportPresence(
  route: RouteCapture | undefined,
  body: unknown,
): Promise<{ status: number; body: string }> {
  if (route === undefined) throw new Error('presence route is not registered')
  const payload = Buffer.from(JSON.stringify(body))
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(payload.length) },
    async *[Symbol.asyncIterator]() {
      yield payload
    },
  }
  const response = {
    status: 0,
    body: '',
    writeHead(status: number) {
      this.status = status
    },
    end(text?: string) {
      this.body = text ?? ''
    },
  }
  await route.handler(request as never, response as never)
  return response
}

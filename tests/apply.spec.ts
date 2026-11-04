import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { Session, SessionId, SESSION_FORMAT_VERSION, type SessionEvent } from '@deepseek-ai/dsh-session'
import { apply, Config, DEFAULT_MAX_REQUEST_BODY_BYTES, DEFAULT_VAPID_SUBJECT } from '../src/index.ts'
import { PushStore } from '../src/store.ts'
import { subscriptionFixture, vapidKeys } from './fixtures.ts'
import { request, response } from './http.ts'

const webPush = vi.hoisted(() => ({
  generateVAPIDKeys: vi.fn(() => ({ publicKey: 'AQID', privateKey: 'BAUG' })),
  sendNotification: vi.fn<typeof import('web-push').sendNotification>(async () => ({
    statusCode: 201,
    headers: {},
    body: '',
  })),
  getVapidHeaders: vi.fn(),
}))

vi.mock('web-push', () => ({ default: webPush }))

let root: string
const contexts: Context[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-web-push-apply-'))
})

afterEach(async () => {
  await Promise.all(contexts.splice(0).map((ctx) => ctx.fiber.dispose()))
  rmSync(root, { recursive: true, force: true })
  vi.resetAllMocks()
  vi.restoreAllMocks()
})

function createContext(baseDir = root, profile?: { name: string; dir: string }) {
  const ctx = new Context().extend({ baseUrl: `${pathToFileURL(baseDir).href}/` })
  const routes: WebRoute[] = []
  ctx.provide('connection', {
    requestRejection: () => undefined,
  } satisfies Pick<Context['connection'], 'requestRejection'>)
  ctx.provide('webServer', {
    register(route: WebRoute) {
      routes.push(route)
      return () => {
        routes.splice(routes.indexOf(route), 1)
      }
    },
  } satisfies Pick<Context['webServer'], 'register'>)
  if (profile !== undefined) ctx.provide('profileContext', profile)
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
  vi.spyOn(ctx.logger, 'info').mockImplementation(() => undefined)
  contexts.push(ctx)
  return { ctx, routes, warn }
}

function completedTurn(text = 'The answer.', origin?: 'subagent') {
  const id = SessionId(origin === 'subagent' ? 'session-child' : 'session-parent')
  const session = Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    isSeeded: false,
    ...(origin === undefined ? {} : { origin }),
  })
  session.append(
    'assistant/message',
    {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1' as SessionEvent<'assistant/message'>['data']['message']['id'],
        role: 'assistant',
        source: { kind: 'model', provider: 'test', model: 'test' },
        content: [{ type: 'text', text }],
      },
      stream: [],
    },
    { surfaceOp: 'append' },
  )
  const end = session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return { session, end }
}

describe('host plugin registration', () => {
  it('ignores non-notifying events without reading the session history', () => {
    const { ctx } = createContext()
    apply(ctx, { storagePath: join(root, 'state.json') })
    const { session } = completedTurn()
    const assistant = session.snapshotEvents()[0]
    const start = session.append('turn/start', { turn: 2 })
    const tool = session.append('tool/call', {
      turn: 2,
      step: 1,
      callId: 'ordinary-call' as SessionEvent<'tool/call'>['data']['callId'],
      name: 'bash',
      arguments: '{}',
    })
    const snapshot = vi.spyOn(session, 'snapshotEvents')

    for (const event of [assistant, start, tool]) ctx.emit('session/event', session, event)

    expect(snapshot).not.toHaveBeenCalled()
    expect(webPush.sendNotification).not.toHaveBeenCalled()
  })

  it.each(['summary', 'full'] as const)('reads full content only once when delivering %s bodies', async (bodyMode) => {
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => vapidKeys)
    for (let device = 0; device < 3; device++) {
      store.upsert(subscriptionFixture(`https://push.example.test/device-${String(device)}`, { bodyMode }))
    }
    const { ctx } = createContext()
    apply(ctx, { storagePath })
    const { session, end } = completedTurn()
    const assistant = session.snapshotEvents()[0]
    if (assistant.type !== 'assistant/message') throw new Error('missing assistant fixture')
    const content = vi.fn(() => assistant.data.message.content)
    const observed = {
      ...assistant,
      data: {
        ...assistant.data,
        message: {
          ...assistant.data.message,
          get content() {
            return content()
          },
        },
      },
    }
    const snapshot = vi.spyOn(session, 'snapshotEvents').mockReturnValue([observed, end])

    ctx.emit('session/event', session, end)
    await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(3))

    expect(snapshot).toHaveBeenCalledOnce()
    expect(content).toHaveBeenCalledTimes(bodyMode === 'full' ? 1 : 0)
    const bodies = () => webPush.sendNotification.mock.calls.map(([, payload]) => JSON.parse(String(payload)).body)
    expect(bodies()).toEqual(Array(3).fill(bodyMode === 'full' ? 'The answer.' : 'Turn 1 completed.'))

    const next = completedTurn('A new answer.')
    ctx.emit('session/event', next.session, next.end)
    await vi.waitFor(() => expect(webPush.sendNotification).toHaveBeenCalledTimes(6))
    expect(bodies().slice(3)).toEqual(Array(3).fill(bodyMode === 'full' ? 'A new answer.' : 'Turn 1 completed.'))
  })

  it('registers every route and returns their disposers through the effect', async () => {
    const { ctx, routes } = createContext()
    apply(ctx, {
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
    await ctx.fiber.dispose()
    expect(routes).toEqual([])
  })

  it('keeps each profile\u2019s state inside that profile\u2019s directory', () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'home')
    try {
      const stateFor = (profile: string): string => {
        const dir = join(root, 'profiles', profile)
        mkdirSync(dir, { recursive: true })
        const { ctx } = createContext(dir, { name: profile, dir })
        apply(ctx, { vapidSubject: 'mailto:test@example.invalid', maxRequestBodyBytes: 1024 })
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

  it('creates independent profile state when the Harness home already has a store', () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = join(root, 'home')
    try {
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
      const { ctx } = createContext(dir, { name: 'web', dir })
      apply(ctx, { vapidSubject: 'mailto:test@example.invalid', maxRequestBodyBytes: 1024 })

      const persisted = JSON.parse(readFileSync(join(dir, 'web-push', 'state.json'), 'utf8')) as {
        vapid: { publicKey: string }
        subscriptions: unknown[]
      }
      expect(persisted.vapid.publicKey).toBe('AQID')
      expect(webPush.generateVAPIDKeys).toHaveBeenCalledOnce()
      expect(persisted.subscriptions).toEqual([])
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })

  it('delivers an event to eligible subscriptions and contains one send failure', async () => {
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => vapidKeys)
    store.upsert(subscriptionFixture('https://push.example.test/full'))
    store.upsert(subscriptionFixture('https://push.example.test/summary', { bodyMode: 'summary' }))
    store.upsert(subscriptionFixture('https://push.example.test/disabled', { turnCompleted: false }))
    webPush.sendNotification.mockImplementation(async (value) => {
      if (value.endpoint.endsWith('/full')) throw new Error('network down')
      return { statusCode: 201, headers: {}, body: '' }
    })
    const { ctx, warn } = createContext()
    apply(ctx, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const { session, end } = completedTurn()
    ctx.emit('session/event', session, end)

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
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => vapidKeys)
    store.upsert(subscriptionFixture('https://push.example.test/full'))
    const { ctx, routes } = createContext()
    apply(ctx, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const presenceRoute = routes.find((route) => route.path === '/__dsh/web-push/presence')
    const { session, end } = completedTurn()

    expect((await reportPresence(presenceRoute, { id: 'desktop-page', active: true })).status).toBe(200)
    ctx.emit('session/event', session, end)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(webPush.sendNotification).not.toHaveBeenCalled()

    expect((await reportPresence(presenceRoute, { id: 'desktop-page', active: false })).status).toBe(200)
    ctx.emit('session/event', session, end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
    })
  })

  it('keeps delivering while a page is in focus once the quiet period is switched off', async () => {
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => vapidKeys)
    // The operator's own choice in Settings, read back from storage on boot.
    store.setSettings({ suppressWhileActive: false, idleMinutes: 10 })
    store.upsert(subscriptionFixture('https://push.example.test/full'))
    const { ctx, routes } = createContext()
    apply(ctx, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const presenceRoute = routes.find((route) => route.path === '/__dsh/web-push/presence')
    const { session, end } = completedTurn()

    expect((await reportPresence(presenceRoute, { id: 'desktop-page', active: true })).status).toBe(200)
    ctx.emit('session/event', session, end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
    })
  })

  it("keeps a subagent's own turn quiet unless a device asks for it", async () => {
    const storagePath = join(root, 'state.json')
    const store = PushStore.open(storagePath, () => vapidKeys)
    store.upsert(subscriptionFixture('https://push.example.test/quiet'))
    store.upsert(subscriptionFixture('https://push.example.test/asks', { subagentRuns: true }))
    const { ctx } = createContext()
    apply(ctx, {
      vapidSubject: 'mailto:test@example.invalid',
      storagePath,
      maxRequestBodyBytes: 1024,
    })
    const child = completedTurn('Found it.', 'subagent')
    ctx.emit('session/event', child.session, child.end)
    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(1)
    })
    expect(webPush.sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'https://push.example.test/asks' }),
      expect.any(String),
      expect.anything(),
    )

    // A top-level session still reaches every device that enabled the kind.
    const parent = completedTurn('Found it.')
    ctx.emit('session/event', parent.session, parent.end)
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

  it('uses the Harness home outside a profile', () => {
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const { ctx } = createContext()
      apply(ctx)
      expect(existsSync(dshHomePath('web-push', 'state.json'))).toBe(true)
    } finally {
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
    }
  })
})

async function reportPresence(route: WebRoute | undefined, body: unknown) {
  if (route === undefined) throw new Error('presence route is not registered')
  const result = response()
  await route.handler(request('POST', body), result.response)
  return result
}

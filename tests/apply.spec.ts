import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { apply } from '../src/index.ts'
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
      maxRequestBodyBytes: 1024,
    })
    expect(existsSync(join(root, 'web-push.json'))).toBe(true)
    expect(routes.map((route) => route.path)).toEqual([
      '/__dsh/web-push/config',
      '/__dsh/web-push/sw.js',
      '/__dsh/web-push/subscribe',
      '/__dsh/web-push/unsubscribe',
      '/__dsh/web-push/test',
    ])
    for (const dispose of disposers) dispose()
    expect(routes).toEqual([])
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
    onSessionEvent?.({ id: 'session-1', snapshotEvents: () => [assistant, end] } as Session, end)

    await vi.waitFor(() => {
      expect(webPush.sendNotification).toHaveBeenCalledTimes(2)
    })
    const bodies = webPush.sendNotification.mock.calls.map(
      ([, payload]) => (JSON.parse(String(payload)) as { body: string }).body,
    )
    expect(bodies).toEqual(['The answer.', 'Turn 1 completed.'])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

function subscription(endpoint: string, bodyMode: 'full' | 'summary', turnCompleted: boolean) {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: 'AQID', auth: 'BAUG' },
    preferences: { turnCompleted, turnFailed: true, approval: true, question: true, bodyMode },
  }
}

function event(value: unknown): SessionEvent {
  return value as SessionEvent
}

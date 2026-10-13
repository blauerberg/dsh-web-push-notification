import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'

vi.mock('../src/client/WebPushSettingsSection.tsx', () => ({ WebPushSettingsSection: () => null }))

afterEach(() => {
  vi.unstubAllGlobals()
})

function harness(href: string) {
  const openSession = vi.fn()
  let onMessage: ((event: MessageEvent<unknown>) => void) | undefined
  const removeMessageListener = vi.fn()
  const cleanup: Array<() => void> = []
  vi.stubGlobal('navigator', {
    serviceWorker: {
      addEventListener: (_type: string, listener: (event: MessageEvent<unknown>) => void) => {
        onMessage = listener
      },
      removeEventListener: removeMessageListener,
    },
  })
  vi.stubGlobal('window', {
    location: { href },
    history: { state: null, replaceState: vi.fn() },
  })
  const ctx = {
    slots: { inject: vi.fn() },
    uiWorkspace: { openSession },
    effect: (setup: () => () => void) => {
      cleanup.push(setup())
    },
  } as unknown as ClientContext
  return {
    ctx,
    openSession,
    removeMessageListener,
    cleanup,
    listen: (data: unknown) => onMessage?.({ data } as MessageEvent<unknown>),
  }
}

describe('notification navigation', () => {
  it('opens the session named by the launch URL parameter and strips the parameter', () => {
    const setup = harness('https://dsh.example.test/?dshSession=session-1')
    apply(setup.ctx)
    expect(setup.openSession).toHaveBeenCalledWith('session-1')
    expect(window.history.replaceState).toHaveBeenCalledWith(null, '', '/')
    setup.cleanup.forEach((dispose) => {
      dispose()
    })
    expect(setup.removeMessageListener).toHaveBeenCalledOnce()
  })

  it('opens the session a notification click posts from the Service Worker', () => {
    const setup = harness('https://dsh.example.test/')
    apply(setup.ctx)
    expect(setup.openSession).not.toHaveBeenCalled()
    setup.listen({ type: 'dsh-web-push/open-session', sessionId: 'session-2' })
    expect(setup.openSession).toHaveBeenCalledWith('session-2')
    setup.listen({ type: 'some-other-message', sessionId: 'session-3' })
    expect(setup.openSession).toHaveBeenCalledTimes(1)
  })

  it('ignores an empty, oversized, or absent session id from the Service Worker', () => {
    const setup = harness('https://dsh.example.test/')
    apply(setup.ctx)
    setup.listen({ type: 'dsh-web-push/open-session', sessionId: '' })
    setup.listen({ type: 'dsh-web-push/open-session', sessionId: 'x'.repeat(513) })
    setup.listen({ type: 'dsh-web-push/open-session' })
    setup.listen({ type: 'dsh-web-push/open-session', sessionId: 42 })
    expect(setup.openSession).not.toHaveBeenCalled()
  })
})

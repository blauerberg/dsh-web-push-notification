import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply } from '../src/client/index.ts'

vi.mock('../src/client/WebPushSettingsSection.tsx', () => ({ WebPushSettingsSection: () => null }))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('notification navigation', () => {
  it('stops waiting when the session list is ready without the target', () => {
    let snapshot: { readonly ids: readonly SessionId[]; readonly phase: 'pending' | 'ready' } = {
      ids: [],
      phase: 'pending',
    }
    let notifyListChange: (() => void) | undefined
    const unsubscribe = vi.fn()
    const removeMessageListener = vi.fn()
    const cleanup: Array<() => void> = []
    vi.stubGlobal('navigator', {
      serviceWorker: {
        addEventListener: vi.fn(),
        removeEventListener: removeMessageListener,
      },
    })
    vi.stubGlobal('window', {
      location: { href: 'https://dsh.example.test/?dshSession=missing' },
      history: { state: null, replaceState: vi.fn() },
    })
    const ctx = {
      slots: { inject: vi.fn() },
      sessions: {
        list: {
          getSnapshot: () => snapshot,
          subscribe: (listener: () => void) => {
            notifyListChange = listener
            return unsubscribe
          },
        },
        open: vi.fn(),
      },
      effect: (setup: () => () => void) => {
        cleanup.push(setup())
      },
    } as unknown as ClientContext

    apply(ctx)
    expect(unsubscribe).not.toHaveBeenCalled()

    snapshot = { ids: [], phase: 'ready' }
    notifyListChange?.()
    expect(unsubscribe).toHaveBeenCalledOnce()

    cleanup.forEach((dispose) => {
      dispose()
    })
    expect(removeMessageListener).toHaveBeenCalledOnce()
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { PRESENCE_PATH, WEB_PUSH_ROUTE_PREFIX } from '../src/contract.ts'
import { PRESENCE_TTL_MS, PresenceRegistry } from '../src/presence.ts'
import { ROUTE_PREFIX } from '../src/routes.ts'
import {
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_IDLE_MS,
  type PresenceView,
  startPresenceReporting,
} from '../src/client/presence.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('presence registry', () => {
  it('suppresses only while a page says it is active', () => {
    const presence = new PresenceRegistry()
    expect(presence.anyActive()).toBe(false)
    presence.report('page-1', true)
    expect(presence.anyActive()).toBe(true)
    presence.report('page-1', false)
    expect(presence.anyActive()).toBe(false)
  })

  it('lets one focused page speak for every device', () => {
    const presence = new PresenceRegistry()
    presence.report('phone', false)
    presence.report('desktop', true)
    presence.report('laptop', false)
    expect(presence.anyActive()).toBe(true)
  })

  it('expires a page that stops reporting, so a killed tab cannot mute forever', () => {
    let now = 0
    const presence = new PresenceRegistry(PRESENCE_TTL_MS, () => now)
    presence.report('page-1', true)
    now = PRESENCE_TTL_MS
    expect(presence.anyActive()).toBe(true)
    now = PRESENCE_TTL_MS + 1
    expect(presence.anyActive()).toBe(false)
  })

  it('keeps a page active across heartbeats', () => {
    let now = 0
    const presence = new PresenceRegistry(PRESENCE_TTL_MS, () => now)
    presence.report('page-1', true)
    now = PRESENCE_TTL_MS - 1
    presence.report('page-1', true)
    now = PRESENCE_TTL_MS + 1
    expect(presence.anyActive()).toBe(true)
  })
})

describe('page presence reporter', () => {
  function setup(initial: { visible?: boolean; focused?: boolean } = {}, options: PresenceOptionsForTest = {}) {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(options.policy ?? { ok: true }), { status: 200 }),
    )
    const beacon = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('navigator', { sendBeacon: beacon })
    vi.useFakeTimers({ now: 0 })
    const page = fakeView(initial)
    const stop = startPresenceReporting({
      view: page.view,
      ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    })
    return {
      page,
      stop,
      beacon,
      posted: (): Array<{ id: string; active: boolean }> =>
        fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as { id: string; active: boolean }),
      url: (): unknown => fetchMock.mock.calls.at(0)?.[0],
      init: (): RequestInit | undefined => fetchMock.mock.calls.at(0)?.[1],
    }
  }

  it('reports a focused page as active and keeps reporting while it stays in front', () => {
    const harness = setup({ visible: true, focused: true })
    const first = harness.posted()
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({ active: true })
    expect(first[0]?.id).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(harness.url()).toBe(PRESENCE_PATH)
    expect(harness.init()).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    expect(harness.posted().map((body) => body.active)).toEqual([true, true])
    harness.stop()
  })

  it('reports a background page as inactive and never heartbeats', () => {
    const harness = setup({ visible: false, focused: false })
    expect(harness.posted()).toEqual([expect.objectContaining({ active: false })])
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 3)
    expect(harness.posted()).toHaveLength(1)
    harness.stop()
  })

  it('goes quiet the moment the page is hidden and speaks up again on focus', () => {
    const harness = setup({ visible: true, focused: true })
    harness.page.setVisible(false)
    harness.page.emit('visibilitychange')
    expect(harness.posted().map((body) => body.active)).toEqual([true, false])
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 2)
    expect(harness.posted()).toHaveLength(2)
    harness.page.setVisible(true)
    harness.page.emit('focus')
    expect(harness.posted().map((body) => body.active)).toEqual([true, false, true])
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS)
    expect(harness.posted().map((body) => body.active)).toEqual([true, false, true, true])
    harness.stop()
  })

  it('stops claiming attention once the window has been idle, and answers the next input', () => {
    const harness = setup({ visible: true, focused: true }, { idleMs: 1000, heartbeatMs: 100 })
    vi.advanceTimersByTime(1100)
    expect(harness.posted().at(-1)?.active).toBe(false)
    harness.page.emit('keydown')
    expect(harness.posted().at(-1)?.active).toBe(true)
    harness.stop()
  })

  it('counts cursor movement and touch scrolling as attention, so a reader never falls idle', () => {
    const harness = setup({ visible: true, focused: true }, { idleMs: 1000, heartbeatMs: 100 })
    for (let step = 0; step < 4; step++) {
      vi.advanceTimersByTime(900)
      harness.page.emit(step % 2 === 0 ? 'pointermove' : 'touchmove')
    }
    expect(harness.posted().every((body) => body.active)).toBe(true)
    vi.advanceTimersByTime(1100)
    expect(harness.posted().at(-1)?.active).toBe(false)
    harness.stop()
  })

  it('adopts the idle window the server reports, so a settings change needs no reload', async () => {
    const harness = setup(
      { visible: true, focused: true },
      {
        idleMs: 1000,
        heartbeatMs: 100,
        policy: { ok: true, suppression: { suppressWhileActive: true, idleMinutes: 1 } },
      },
    )
    await settle()
    // The server's minute outranks the one-second window this page booted with.
    vi.advanceTimersByTime(5000)
    expect(harness.posted().every((body) => body.active)).toBe(true)
    harness.stop()
  })

  it('ignores an idle window it cannot honour instead of guessing', async () => {
    const harness = setup(
      { visible: true, focused: true },
      {
        idleMs: 1000,
        heartbeatMs: 100,
        policy: { ok: true, suppression: { suppressWhileActive: true, idleMinutes: 0 } },
      },
    )
    await settle()
    vi.advanceTimersByTime(1100)
    expect(harness.posted().at(-1)?.active).toBe(false)
    harness.stop()
  })

  /** A policy answer arrives on microtasks, which fake timers never run. */
  async function settle(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) {
      await Promise.resolve()
      await vi.advanceTimersByTimeAsync(0)
    }
  }

  it('releases the mute on dispose and stops listening', async () => {
    const harness = setup({ visible: true, focused: true })
    harness.stop()
    expect(harness.beacon).toHaveBeenCalledOnce()
    const beaconCall = harness.beacon.mock.calls.at(0)
    if (beaconCall === undefined) throw new Error('no beacon was sent')
    expect(beaconCall[0]).toBe(PRESENCE_PATH)
    expect(JSON.parse(await (beaconCall[1] as Blob).text())).toMatchObject({ active: false })
    expect(harness.page.listenerCount('keydown')).toBe(0)
    expect(harness.page.listenerCount('pointermove')).toBe(0)
    expect(harness.page.listenerCount('visibilitychange')).toBe(0)
    harness.page.emit('focus')
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 5)
    expect(harness.posted()).toHaveLength(1)
  })

  it('does not heartbeat forever after a page is hidden', () => {
    const harness = setup({ visible: true, focused: true })
    harness.page.setVisible(false)
    harness.page.emit('visibilitychange')
    const count = harness.posted().length
    vi.advanceTimersByTime(PRESENCE_HEARTBEAT_MS * 5)
    expect(harness.posted()).toHaveLength(count)
    harness.stop()
  })
})

describe('presence defaults', () => {
  it('keeps the heartbeat well inside the server TTL, and idle below it', () => {
    expect(PRESENCE_HEARTBEAT_MS * 3).toBeLessThanOrEqual(PRESENCE_TTL_MS)
    expect(PRESENCE_TTL_MS).toBeLessThan(PRESENCE_IDLE_MS)
  })

  it('holds a focused but untouched page for the ten minutes Slack documents', () => {
    expect(PRESENCE_IDLE_MS).toBe(10 * 60_000)
  })

  it('shares one prefix between the server routes and the client bundle', () => {
    expect(PRESENCE_PATH).toBe('/__dsh/web-push/presence')
    expect(ROUTE_PREFIX).toBe(WEB_PUSH_ROUTE_PREFIX)
  })
})

interface PresenceOptionsForTest {
  readonly idleMs?: number
  readonly heartbeatMs?: number
  /** What the stubbed server answers a report with. */
  readonly policy?: unknown
}

function fakeView(initial: { visible?: boolean; focused?: boolean } = {}) {
  const listeners = new Map<string, Set<() => void>>()
  const state = { visible: initial.visible ?? true, focused: initial.focused ?? true }
  const add = (type: string, listener: () => void): void => {
    const set = listeners.get(type) ?? new Set<() => void>()
    set.add(listener)
    listeners.set(type, set)
  }
  const remove = (type: string, listener: () => void): void => {
    listeners.get(type)?.delete(listener)
  }
  const view: PresenceView = {
    document: {
      get visibilityState(): string {
        return state.visible ? 'visible' : 'hidden'
      },
      hasFocus: () => state.focused,
      addEventListener: add,
      removeEventListener: remove,
    },
    addEventListener: add,
    removeEventListener: remove,
  }
  return {
    view,
    setVisible: (value: boolean) => {
      state.visible = value
    },
    emit: (type: string) => {
      for (const listener of [...(listeners.get(type) ?? [])]) listener()
    },
    listenerCount: (type: string) => listeners.get(type)?.size ?? 0,
  }
}

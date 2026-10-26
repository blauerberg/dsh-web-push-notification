import { PRESENCE_PATH } from '../contract.ts'
import { DEFAULT_SUPPRESSION_SETTINGS } from '../types.ts'
import { validateSettings } from '../validation.ts'

/** The server forgets a page after three missed reports. */
export const PRESENCE_HEARTBEAT_MS = 20_000
export const PRESENCE_IDLE_MS = DEFAULT_SUPPRESSION_SETTINGS.idleMinutes * 60_000

const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel'] as const

export function startPresenceReporting(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  const view = window
  const id = globalThis.crypto?.randomUUID?.() ?? `${String(Date.now())}-${Math.random().toString(36).slice(2)}`
  let idleMs = PRESENCE_IDLE_MS
  let lastInputAt = Date.now()
  let active: boolean | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let disposed = false

  function post(next: boolean, beacon = false): void {
    const body = JSON.stringify({ id, active: next })
    // A beacon survives the teardown that would cancel an ordinary fetch.
    if (beacon) {
      navigator.sendBeacon?.(PRESENCE_PATH, new Blob([body], { type: 'application/json' }))
      return
    }
    void fetch(PRESENCE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
    })
      .then(async (response) => {
        if (!response.ok || disposed) return
        const result: unknown = await response.json()
        if (typeof result !== 'object' || result === null) return
        const nextIdleMs = validateSettings((result as Record<string, unknown>).suppression).idleMinutes * 60_000
        if (nextIdleMs === idleMs) return
        idleMs = nextIdleMs
        sync()
      })
      .catch(() => {})
  }

  function sync(): void {
    if (disposed) return
    const next =
      view.document.visibilityState === 'visible' && view.document.hasFocus() && Date.now() - lastInputAt < idleMs
    if (next === active) return
    active = next
    post(next)
    clearInterval(heartbeat)
    heartbeat = next
      ? setInterval(() => {
          sync()
          if (active) post(true)
        }, PRESENCE_HEARTBEAT_MS)
      : undefined
  }

  function onInput(): void {
    lastInputAt = Date.now()
    sync()
  }

  function onHide(): void {
    clearInterval(heartbeat)
    heartbeat = undefined
    active = false
    post(false, true)
  }

  view.document.addEventListener('visibilitychange', sync)
  view.addEventListener('focus', sync)
  view.addEventListener('blur', sync)
  view.addEventListener('pagehide', onHide)
  view.addEventListener('pageshow', sync)
  for (const type of INPUT_EVENTS) view.addEventListener(type, onInput)
  sync()

  return () => {
    if (disposed) return
    if (active) onHide()
    disposed = true
    clearInterval(heartbeat)
    view.document.removeEventListener('visibilitychange', sync)
    view.removeEventListener('focus', sync)
    view.removeEventListener('blur', sync)
    view.removeEventListener('pagehide', onHide)
    view.removeEventListener('pageshow', sync)
    for (const type of INPUT_EVENTS) view.removeEventListener(type, onInput)
  }
}

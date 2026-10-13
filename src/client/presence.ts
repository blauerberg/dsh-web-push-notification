import { PRESENCE_PATH } from '../contract.ts'
import { MAX_IDLE_MINUTES, MIN_IDLE_MINUTES } from '../types.ts'

/**
 * How often an active page re-reports itself. The server's TTL is three times
 * this, so one lost report does not let a notification through.
 */
export const PRESENCE_HEARTBEAT_MS = 20_000

/**
 * A focused window on a machine nobody has touched is not attention. Past this
 * much silence the page reports itself inactive, so a desktop left open on the
 * far side of the room does not keep a phone quiet all evening.
 *
 * Ten minutes is Slack's documented default for the same judgement: it resumes
 * mobile notifications "10 minutes after Slack stops detecting cursor
 * activity". Discord offers the same idea as "Push Notification Inactive
 * Timeout", so the value is a known-good point rather than a guess.
 */
export const PRESENCE_IDLE_MS = 10 * 60_000

/**
 * What counts as using the page. Slack measures its away state in cursor
 * activity, so movement has to hold the page active: reading a long answer
 * without clicking anything is still attention, and without the movement
 * events the page would fall idle under a user who is still reading it.
 */
const INPUT_EVENTS = ['keydown', 'pointerdown', 'pointermove', 'touchstart', 'touchmove', 'wheel'] as const

/** The window and document surface the reporter touches, so a test can supply its own. */
export interface PresenceView {
  readonly document: {
    readonly visibilityState: string
    hasFocus(): boolean
    addEventListener(type: string, listener: () => void): void
    removeEventListener(type: string, listener: () => void): void
  }
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface PresenceOptions {
  readonly view?: PresenceView
  readonly now?: () => number
  readonly heartbeatMs?: number
  readonly idleMs?: number
}

/**
 * Report this page's focus, visibility and idleness until the returned disposer
 * runs. The page is one of possibly several across the user's devices, and the
 * server suppresses notifications while any of them is active.
 */
export function startPresenceReporting(options: PresenceOptions = {}): () => void {
  // A client plugin can load in a context with no document; then there is no
  // focus to report and nothing to suppress.
  const detected = options.view ?? (typeof document === 'undefined' ? undefined : (window as unknown as PresenceView))
  if (detected === undefined) return () => {}
  const view: PresenceView = detected
  const now = options.now ?? Date.now
  const heartbeatMs = options.heartbeatMs ?? PRESENCE_HEARTBEAT_MS
  // The default until the server answers; from then on the user's setting.
  let idleMs = options.idleMs ?? PRESENCE_IDLE_MS
  const id = clientId()
  let lastInputAt = now()
  let active: boolean | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let disposed = false

  /**
   * Every report is answered with the policy it was judged against, so a change
   * made in Settings reaches a page that is already open: the next heartbeat
   * adopts the new idle window and no reload is needed. A value this page cannot
   * use is ignored rather than guessed at, leaving the window it already had.
   */
  const applyPolicy = async (response: Response): Promise<void> => {
    if (!response.ok) return
    let body: unknown
    try {
      body = await response.json()
    } catch {
      return
    }
    const suppression = isRecord(body) ? body.suppression : undefined
    const minutes = isRecord(suppression) ? suppression.idleMinutes : undefined
    if (
      typeof minutes !== 'number' ||
      !Number.isInteger(minutes) ||
      minutes < MIN_IDLE_MINUTES ||
      minutes > MAX_IDLE_MINUTES
    ) {
      return
    }
    const next = minutes * 60_000
    if (next === idleMs) return
    idleMs = next
    // A shorter window can put this page past its own limit immediately.
    sync()
  }

  const post = (next: boolean, beacon = false): void => {
    const body = JSON.stringify({ id, active: next })
    // The unload path cannot await a fetch, and a beacon survives the teardown
    // that would otherwise cancel one.
    if (beacon) {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon(PRESENCE_PATH, new Blob([body], { type: 'application/json' }))
      }
      return
    }
    // A report that never lands costs one redundant notification, never a lost
    // one: the page simply stops muting until its next heartbeat.
    void fetch(PRESENCE_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body,
    })
      .then(applyPolicy)
      .catch(() => {})
  }

  function stopHeartbeat(): void {
    if (heartbeat === undefined) return
    clearInterval(heartbeat)
    heartbeat = undefined
  }

  function apply(next: boolean): void {
    active = next
    post(next)
    if (!next) {
      stopHeartbeat()
      return
    }
    heartbeat ??= setInterval(beat, heartbeatMs)
  }

  function beat(): void {
    if (disposed || active !== true) return
    // The state can change without an event: input simply stops.
    if (!isActive()) {
      apply(false)
      return
    }
    post(true)
  }

  function isActive(): boolean {
    return view.document.visibilityState === 'visible' && view.document.hasFocus() && now() - lastInputAt < idleMs
  }

  function sync(): void {
    if (disposed) return
    const next = isActive()
    if (next === active) return
    apply(next)
  }

  function onInput(): void {
    lastInputAt = now()
    sync()
  }

  function onHide(): void {
    if (disposed) return
    stopHeartbeat()
    active = false
    post(false, true)
  }

  view.document.addEventListener('visibilitychange', sync)
  view.addEventListener('focus', sync)
  view.addEventListener('blur', sync)
  view.addEventListener('pagehide', onHide)
  // A page restored from the back/forward cache is alive again and must say so.
  view.addEventListener('pageshow', sync)
  for (const type of INPUT_EVENTS) view.addEventListener(type, onInput)
  sync()

  return () => {
    if (disposed) return
    disposed = true
    stopHeartbeat()
    view.document.removeEventListener('visibilitychange', sync)
    view.removeEventListener('focus', sync)
    view.removeEventListener('blur', sync)
    view.removeEventListener('pagehide', onHide)
    view.removeEventListener('pageshow', sync)
    for (const type of INPUT_EVENTS) view.removeEventListener(type, onInput)
    if (active === true) post(false, true)
  }
}

/**
 * Opaque to the server, unique per page load: two tabs are two reporters, and a
 * reloaded tab retires its predecessor by never refreshing it again.
 */
function clientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${String(Date.now())}-${Math.random().toString(36).slice(2)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

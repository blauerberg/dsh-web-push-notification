import { createHash } from 'node:crypto'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NotificationBodyMode, NotificationKind, PushHeaders, PushUrgency } from './types.ts'

/** Leave room for the rest of the encrypted Web Push payload and its framing. */
export const MAX_NOTIFICATION_BODY_BYTES = 2000

/**
 * Longest title worth sending.
 *
 * Android draws a notification title on a single line whatever the style, and
 * truncates the rest, so a longer title only takes characters away from the
 * session name it is there to identify.
 */
export const MAX_NOTIFICATION_TITLE_CHARS = 48

/**
 * The word every title leads with.
 *
 * A phone holding a stack of these rows is scanned for one thing - which of
 * them wants an answer, and which merely finished - so the kind goes first,
 * where the single-line truncation cannot reach it.
 */
const KIND_LABELS: Record<NotificationKind, string> = {
  turnCompleted: 'Done',
  turnFailed: 'Stopped',
  approval: 'Approval',
  question: 'Question',
}

const KIND_URGENCY: Record<NotificationKind, PushUrgency> = {
  turnCompleted: 'normal',
  turnFailed: 'high',
  approval: 'high',
  question: 'high',
}

export interface NotificationOptions {
  readonly bodyMode?: NotificationBodyMode
  readonly events?: readonly SessionEvent[]
  /**
   * The session's own title. It is folded into the notification title, so a
   * phone showing several sessions says which one each row belongs to; the
   * Harness name stands in for a log that carries no title yet.
   */
  readonly sessionTitle?: string
}

export interface NotificationMessage {
  readonly kind: NotificationKind
  readonly title: string
  readonly body: string
  readonly tag: string
  readonly url: string
  readonly sessionId: string
  /** Read by the sender for the Push service; the page ignores it. */
  readonly urgency: PushUrgency
  readonly topic: string
}

/**
 * Latest logged `session/title` text, or `undefined` before one lands.
 *
 * The event is declared by `@deepseek-ai/dsh-session-title`, a package this
 * plugin deliberately does not depend on, so the log is read structurally: the
 * fold is last-wins and touches nothing but `data.title`.
 */
export function sessionTitleOf(events: readonly SessionEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index] as unknown as { readonly type?: unknown; readonly data?: unknown } | undefined
    if (candidate?.type !== 'session/title') continue
    const data = candidate.data as { readonly title?: unknown } | undefined
    if (typeof data?.title !== 'string') continue
    const title = data.title.trim()
    if (title !== '') return title
  }
  return undefined
}

export function notificationForEvent(
  sessionId: string,
  event: SessionEvent,
  options: NotificationOptions = {},
): NotificationMessage | undefined {
  const bodyMode = options.bodyMode ?? 'full'
  const events = options.events ?? []
  const sessionTitle = options.sessionTitle?.trim()
  const titled = (kind: NotificationKind): string => titleFor(kind, sessionTitle === '' ? undefined : sessionTitle)
  switch (event.type) {
    case 'turn/end': {
      const kind = event.data.reason.kind === 'completed' ? 'turnCompleted' : 'turnFailed'
      const summary = `Turn ${String(event.data.turn)} ${kind === 'turnCompleted' ? 'completed.' : `${event.data.reason.kind}.`}`
      const body = bodyMode === 'full' ? fullTurnBody(event, events, summary) : summary
      return message(sessionId, kind, titled(kind), body)
    }
    case 'tool/call':
      if (event.data.name !== 'ask_user_question') return undefined
      return message(
        sessionId,
        'question',
        titled('question'),
        bodyMode === 'full' ? questionBody(event.data.arguments) : 'A response is required to continue the turn.',
      )
    default:
      return approvalMessage(sessionId, event, bodyMode, titled('approval'))
  }
}

function fullTurnBody(
  event: Extract<SessionEvent, { type: 'turn/end' }>,
  events: readonly SessionEvent[],
  fallback: string,
): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const candidate = events[index]
    if (candidate?.type !== 'assistant/message' || candidate.data.turn !== event.data.turn) continue
    const text = candidate.data.message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim()
    if (text !== '') return trimBody(text)
  }
  if (event.data.reason.kind === 'error') return trimBody(event.data.reason.error.message)
  return fallback
}

function approvalMessage(
  sessionId: string,
  event: SessionEvent,
  bodyMode: NotificationBodyMode,
  title: string,
): NotificationMessage | undefined {
  if ((event.type as string) !== 'approval/asked') return undefined
  const data = event.data as unknown as { readonly toolName: string; readonly reason?: string }
  const summary = `Approval is required for ${data.toolName}.`
  const body = bodyMode === 'full' && typeof data.reason === 'string' && data.reason !== '' ? data.reason : summary
  return message(sessionId, 'approval', title, body)
}

function questionBody(argumentsText: string): string {
  try {
    const value: unknown = JSON.parse(argumentsText)
    if (isRecord(value) && Array.isArray(value.questions)) {
      const questions = value.questions
        .filter(isRecord)
        .map((question) => question.question)
        .filter((question): question is string => typeof question === 'string' && question !== '')
      if (questions.length > 0) return trimBody(questions.join('\n'))
    }
  } catch {
    // The raw tool arguments remain the only available content when parsing fails.
  }
  return trimBody(argumentsText)
}

/** `Done · Fix the paste bug`, clamped where Android would cut it anyway. */
function titleFor(kind: NotificationKind, sessionTitle: string | undefined): string {
  const name = sessionTitle === undefined ? 'DeepSeek Harness' : sessionTitle
  return clampTitle(`${KIND_LABELS[kind]} · ${name}`)
}

function clampTitle(value: string): string {
  const characters = Array.from(value)
  if (characters.length <= MAX_NOTIFICATION_TITLE_CHARS) return value
  const kept = characters
    .slice(0, MAX_NOTIFICATION_TITLE_CHARS - 3)
    .join('')
    .trimEnd()
  return `${kept}...`
}

/**
 * A stable name for "this session, this kind of news", used as the Push
 * service's `Topic`.
 *
 * A queued message whose topic is already in the queue is replaced rather than
 * delivered twice, so a phone that was offline wakes to one row per session
 * instead of a backlog of stale turn reports. The header is capped at 32
 * URL-safe characters and a session id is 36 on its own, so the pair is hashed
 * rather than concatenated.
 */
function topicFor(sessionId: string, kind: NotificationKind): string {
  return createHash('sha256').update(`${sessionId}:${kind}`).digest('base64url').slice(0, 22)
}

/**
 * The Push headers a payload asks for.
 *
 * Read structurally, so a payload built by the settings page's test button -
 * which carries neither field - is delivered with the sender's own defaults.
 */
export function pushHeadersOf(payload: unknown): PushHeaders {
  if (!isRecord(payload)) return {}
  const urgency = payload.urgency
  const topic = payload.topic
  return {
    urgency: isUrgency(urgency) ? urgency : undefined,
    topic: typeof topic === 'string' && topic !== '' ? topic : undefined,
  }
}

function isUrgency(value: unknown): value is PushUrgency {
  return value === 'very-low' || value === 'low' || value === 'normal' || value === 'high'
}

function message(sessionId: string, kind: NotificationKind, title: string, body: string): NotificationMessage {
  return {
    kind,
    title,
    body: trimBody(prettify(body)),
    // The session and the kind are the whole tag: two sessions reaching the same
    // outcome must not collapse into one row on the phone, and neither must a
    // question and a finished turn in the same session. The turn number is
    // deliberately absent, so a second completion replaces the first row for
    // that session instead of stacking a near-duplicate beside it; the worker
    // sets `renotify` so the replacement still alerts.
    tag: `dsh-web-push-${sessionId}-${kind}`,
    url: `/?dshSession=${encodeURIComponent(sessionId)}`,
    sessionId,
    urgency: KIND_URGENCY[kind],
    topic: topicFor(sessionId, kind),
  }
}

/**
 * Markdown reduced to the plain prose a notification can actually draw.
 *
 * Android renders a notification body as literal text: `**What I did:**` and a
 * `[label](C:\path)` link arrive with their punctuation intact, which is noise
 * in a two-line preview and unreadable in the expanded one. The app remains the
 * place to read the formatted version, so nothing here has to be reversible.
 */
export function prettify(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // Fences mark where code starts and ends; the code itself is worth keeping.
      .replace(/^[ \t]*(?:```|~~~)[^\n]*$/gm, '')
      .replace(/!\[([^\[\]]*)\]\([^()]*\)/g, '$1')
      .replace(/\[([^\[\]]*)\]\([^()]*\)/g, '$1')
      .replace(/\[([^\[\]]*)\]\[[^\[\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      .replace(/`([^`\n]*)`/g, '$1')
      .replace(/\*\*(\S(?:[^*\n]*\S)?)\*\*/g, '$1')
      .replace(/__(\S(?:[^_\n]*\S)?)__/g, '$1')
      .replace(/~~(\S(?:[^~\n]*\S)?)~~/g, '$1')
      // The lookarounds keep `*.ts` and `snake_case_name` intact.
      .replace(/(?<![\w*])\*(\S(?:[^*\n]*\S)?)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])_(\S(?:[^_\n]*\S)?)_(?![\w_])/g, '$1')
      .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
      .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
      .replace(/^[ \t]*[-*+][ \t]+/gm, '• ')
      .replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '')
      // A table cannot be drawn in a body either; its cells survive as one line.
      .replace(/^[ \t]*\|[ \t]*[:\-| \t]*\|[ \t]*$/gm, '')
      .replace(/^[ \t]*\|(.+)\|[ \t]*$/gm, (_match, row: string) =>
        row
          .split('|')
          .map((cell) => cell.trim())
          .filter((cell) => cell !== '')
          .join(' · '),
      )
      // A line of nothing but dots is filler, not content.
      .replace(/^[ \t]*\.{3,}[ \t]*$/gm, '')
      .replace(/\\([\\`*_{}\[\]()#+\-.!>~])/g, '$1')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  )
}

function trimBody(value: string): string {
  const encoder = new TextEncoder()
  if (encoder.encode(value).byteLength <= MAX_NOTIFICATION_BODY_BYTES) return value
  const suffix = '…'
  const limit = MAX_NOTIFICATION_BODY_BYTES - encoder.encode(suffix).byteLength
  let bytes = 0
  let result = ''
  for (const character of value) {
    const characterBytes = encoder.encode(character).byteLength
    if (bytes + characterBytes > limit) break
    result += character
    bytes += characterBytes
  }
  return `${result}${suffix}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

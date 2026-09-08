import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { NotificationBodyMode, NotificationKind } from './types.ts'

/** Leave room for the rest of the encrypted Web Push payload and its framing. */
export const MAX_NOTIFICATION_BODY_BYTES = 2000

export interface NotificationOptions {
  readonly bodyMode?: NotificationBodyMode
  readonly events?: readonly SessionEvent[]
}

export interface NotificationMessage {
  readonly kind: NotificationKind
  readonly title: string
  readonly body: string
  readonly tag: string
  readonly url: string
  readonly sessionId: string
}

export function notificationForEvent(
  sessionId: string,
  event: SessionEvent,
  options: NotificationOptions = {},
): NotificationMessage | undefined {
  const bodyMode = options.bodyMode ?? 'full'
  const events = options.events ?? []
  switch (event.type) {
    case 'turn/end': {
      const kind = event.data.reason.kind === 'completed' ? 'turnCompleted' : 'turnFailed'
      const title = kind === 'turnCompleted' ? 'DeepSeek Harness: task completed' : 'DeepSeek Harness: task stopped'
      const summary = `Turn ${String(event.data.turn)} ${kind === 'turnCompleted' ? 'completed.' : `${event.data.reason.kind}.`}`
      const body = bodyMode === 'full' ? fullTurnBody(event, events, summary) : summary
      return message(sessionId, kind, title, body, `turn-${String(event.data.turn)}-${event.data.reason.kind}`)
    }
    case 'tool/call':
      if (event.data.name !== 'ask_user_question') return undefined
      return message(
        sessionId,
        'question',
        'DeepSeek Harness: response required',
        bodyMode === 'full' ? questionBody(event.data.arguments) : 'A response is required to continue the turn.',
        `question-${String(event.data.callId)}`,
      )
    default:
      return approvalMessage(sessionId, event, bodyMode)
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
): NotificationMessage | undefined {
  if ((event.type as string) !== 'approval/asked') return undefined
  const data = event.data as unknown as { readonly id: string; readonly toolName: string; readonly reason?: string }
  const summary = `Approval is required for ${data.toolName}.`
  const body = bodyMode === 'full' && typeof data.reason === 'string' && data.reason !== '' ? data.reason : summary
  return message(sessionId, 'approval', 'DeepSeek Harness: approval required', body, `approval-${data.id}`)
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

function message(
  sessionId: string,
  kind: NotificationKind,
  title: string,
  body: string,
  tag: string,
): NotificationMessage {
  return {
    kind,
    title,
    body: trimBody(body),
    tag: `dsh-web-push-${tag}`,
    url: `/?dshSession=${encodeURIComponent(sessionId)}`,
    sessionId,
  }
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

import { describe, expect, it } from 'vitest'
import {
  MAX_NOTIFICATION_BODY_BYTES,
  MAX_NOTIFICATION_TITLE_CHARS,
  notificationForEvent,
  prettify,
  pushHeadersOf,
  sessionTitleOf,
} from '../src/notification.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

function event(value: unknown): SessionEvent {
  return value as SessionEvent
}

const endOfTurn = (turn: number): SessionEvent =>
  event({ type: 'turn/end', seq: 2, time: 2, data: { turn, reason: { kind: 'completed' } } })

const approval = event({ type: 'approval/asked', data: { id: 'approval-1', toolName: 'bash', reason: 'Allow?' } })

const question = event({
  type: 'tool/call',
  data: {
    callId: 'call-1',
    name: 'ask_user_question',
    arguments: JSON.stringify({ questions: [{ question: 'Continue?' }] }),
  },
})

describe('notification projection', () => {
  it('uses the latest assistant text for full mode and a status for summary mode', () => {
    const assistant = event({
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'The answer.' }] } },
    })
    const end = event({
      type: 'turn/end',
      seq: 2,
      time: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    expect(notificationForEvent('session-1', end, { events: [assistant, end] })?.body).toBe('The answer.')
    expect(notificationForEvent('session-1', end, { bodyMode: 'summary', events: [assistant, end] })?.body).toBe(
      'Turn 1 completed.',
    )
  })

  it('includes question text and bounds UTF-8 content', () => {
    const question = event({
      type: 'tool/call',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        callId: 'call-1',
        name: 'ask_user_question',
        arguments: JSON.stringify({ questions: [{ question: 'Continue?' }] }),
      },
    })
    expect(notificationForEvent('session-1', question)?.body).toBe('Continue?')
    const long = event({
      type: 'turn/end',
      seq: 2,
      time: 2,
      data: { turn: 1, reason: { kind: 'completed' } },
    })
    const longAssistant = event({
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'あ'.repeat(2000) }] } },
    })
    const body = notificationForEvent('session-1', long, { events: [longAssistant, long] })?.body ?? ''
    expect(new TextEncoder().encode(body).byteLength).toBeLessThanOrEqual(MAX_NOTIFICATION_BODY_BYTES)
    expect(body.endsWith('…')).toBe(true)
  })

  it('uses the approval reason only in full mode', () => {
    const approval = event({
      type: 'approval/asked',
      data: { id: 'approval-1', toolName: 'bash', reason: 'Allow this command?' },
    })
    expect(notificationForEvent('session-1', approval)?.body).toBe('Allow this command?')
    expect(notificationForEvent('session-1', approval, { bodyMode: 'summary' })?.body).toBe(
      'Approval is required for bash.',
    )
  })
})

describe('notification body', () => {
  it('draws markdown as the plain prose a notification can render', () => {
    const assistant = event({
      type: 'assistant/message',
      seq: 1,
      time: 1,
      data: {
        turn: 1,
        step: 1,
        message: {
          content: [
            {
              type: 'text',
              text: [
                '## What I did',
                '',
                'I wrote **21 points** up as [`voice-analysis.md`](C:\\dev\\wwv\\voice-analysis.md), and `script-v2.md` is *untouched*.',
                '',
                '- first item',
                '- second item',
                '',
                '| a | b |',
                '| --- | --- |',
                '| 1 | 2 |',
                '',
                '```js',
                'const x = 1;',
                '```',
              ].join('\n'),
            },
          ],
        },
      },
    })
    const body = notificationForEvent('session-1', endOfTurn(1), { events: [assistant, endOfTurn(1)] })?.body ?? ''
    expect(body).not.toContain('**')
    expect(body).not.toContain('](')
    expect(body).not.toContain('`')
    expect(body).not.toContain('##')
    expect(body).not.toContain('|')
    expect(body).toContain('What I did')
    expect(body).toContain('I wrote 21 points up as voice-analysis.md')
    expect(body).toContain('script-v2.md is untouched.')
    expect(body).toContain('• first item')
    expect(body).toContain('const x = 1;')
    expect(body).toContain('a · b')
    expect(body).toContain('1 · 2')
  })

  it('leaves identifiers that merely look like emphasis alone', () => {
    expect(prettify('keep snake_case_name and *.ts and 2 * 3')).toBe('keep snake_case_name and *.ts and 2 * 3')
  })

  it('drops a line of nothing but dots', () => {
    expect(prettify('Done.\n\n...\n')).toBe('Done.')
  })
})

describe('session title', () => {
  const titleEvent = (value: unknown): SessionEvent => event({ type: 'session/title', seq: 9, time: 9, data: value })

  it('folds the latest logged title and ignores unusable snapshots', () => {
    expect(sessionTitleOf([titleEvent({ title: 'First' }), titleEvent({ title: 'Latest' })])).toBe('Latest')
    expect(sessionTitleOf([titleEvent({ title: '  Padded  ' })])).toBe('Padded')
    expect(sessionTitleOf([titleEvent({ title: '   ' }), titleEvent({})])).toBeUndefined()
    expect(sessionTitleOf([titleEvent({ title: 7 })])).toBeUndefined()
    expect(sessionTitleOf([])).toBeUndefined()
  })

  it('names the session in the title and keeps the Harness name as the fallback', () => {
    const end = event({ type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'completed' } } })
    expect(notificationForEvent('session-1', end)?.title).toBe('Done · DeepSeek Harness')
    expect(notificationForEvent('session-1', end, { sessionTitle: 'Fix the paste bug' })?.title).toBe(
      'Done · Fix the paste bug',
    )
    expect(notificationForEvent('session-1', end, { sessionTitle: '   ' })?.title).toBe('Done · DeepSeek Harness')
  })

  it('names the session for every kind, not only completed turns', () => {
    expect(notificationForEvent('session-1', approval, { sessionTitle: 'Ship it' })?.title).toBe('Approval · Ship it')
    expect(notificationForEvent('session-1', question, { sessionTitle: 'Ship it' })?.title).toBe('Question · Ship it')
  })
})

describe('notification shape', () => {
  it('clamps the title where Android would cut it, keeping the kind in view', () => {
    const title = notificationForEvent('session-1', endOfTurn(1), { sessionTitle: 'x'.repeat(120) })?.title ?? ''
    expect(Array.from(title).length).toBeLessThanOrEqual(MAX_NOTIFICATION_TITLE_CHARS)
    expect(title.startsWith('Done · ')).toBe(true)
    expect(title.endsWith('...')).toBe(true)
  })

  it('leads with the kind so a stacked row says whether it wants an answer', () => {
    const failed = event({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } } })
    expect(notificationForEvent('session-1', failed, { sessionTitle: 'Ship it' })?.title).toBe('Stopped · Ship it')
    expect(notificationForEvent('session-1', approval, { sessionTitle: 'Ship it' })?.title).toBe('Approval · Ship it')
  })

  it('scopes the tag to its session and kind so a repeat replaces rather than stacks', () => {
    const first = notificationForEvent('session-a', endOfTurn(4))
    const second = notificationForEvent('session-a', endOfTurn(5))
    expect(first?.tag).toBe('dsh-web-push-session-a-turnCompleted')
    expect(second?.tag).toBe(first?.tag)
    expect(notificationForEvent('session-b', endOfTurn(5))?.tag).not.toBe(first?.tag)
    // A question and a finished turn in one session are different news.
    expect(notificationForEvent('session-a', question)?.tag).not.toBe(first?.tag)
  })

  it('asks the Push service for high urgency only where waiting costs the answer', () => {
    expect(notificationForEvent('session-1', approval)?.urgency).toBe('high')
    expect(notificationForEvent('session-1', question)?.urgency).toBe('high')
    expect(notificationForEvent('session-1', endOfTurn(1))?.urgency).toBe('normal')
  })

  it('names a topic the header accepts, one per session and kind', () => {
    const topic = notificationForEvent('session-a', endOfTurn(1))?.topic ?? ''
    expect(topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/)
    expect(notificationForEvent('session-a', endOfTurn(9))?.topic).toBe(topic)
    expect(notificationForEvent('session-b', endOfTurn(1))?.topic).not.toBe(topic)
    expect(notificationForEvent('session-a', approval)?.topic).not.toBe(topic)
  })

  it('reads Push headers off a payload and tolerates one without them', () => {
    expect(pushHeadersOf({ urgency: 'high', topic: 'abc' })).toEqual({ urgency: 'high', topic: 'abc' })
    expect(pushHeadersOf({ title: 'Build finished' })).toEqual({ urgency: undefined, topic: undefined })
    expect(pushHeadersOf({ urgency: 'now', topic: 7 })).toEqual({ urgency: undefined, topic: undefined })
    expect(pushHeadersOf('not a payload')).toEqual({})
  })
})

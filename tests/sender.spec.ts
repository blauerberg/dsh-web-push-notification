import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import webpush from 'web-push'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliver } from '../src/delivery.ts'
import { createWebPushSender } from '../src/sender.ts'
import { PushStore } from '../src/store.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'

const subscription = {
  endpoint: 'https://push.example.test/healthy',
  expirationTime: null,
  keys: { p256dh: webpush.generateVAPIDKeys().publicKey, auth: Buffer.alloc(16).toString('base64url') },
  preferences: DEFAULT_NOTIFICATION_PREFERENCES,
}

let root: string | undefined
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

function mockTransport() {
  const requests: https.RequestOptions[] = []
  vi.spyOn(https, 'request').mockImplementation(((
    options: https.RequestOptions,
    onResponse: (response: IncomingMessage) => void,
  ) => {
    requests.push(options)
    const request = Object.assign(new EventEmitter(), {
      write() {},
      end() {
        if (options.path === '/stalled') {
          if (options.timeout !== undefined) setTimeout(() => request.emit('timeout'), options.timeout)
          return
        }
        const response = Object.assign(new EventEmitter(), { statusCode: 201, headers: {} })
        onResponse(response as IncomingMessage)
        response.emit('end')
      },
      destroy(error: Error) {
        request.emit('error', error)
        return request
      },
    })
    return request as ClientRequest
  }) as typeof https.request)
  return requests
}

function identity(options: https.RequestOptions) {
  const headers = options.headers as Record<string, string>
  const authorization = /^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization)
  if (authorization === null) throw new Error('missing VAPID authorization')
  const claims = JSON.parse(Buffer.from(authorization[1].split('.')[1], 'base64url').toString()) as {
    sub: string
  }
  return { subject: claims.sub, publicKey: authorization[2] }
}

describe('Web Push sender', () => {
  it('keeps each sender identity when profiles send in either order', async () => {
    const requests = mockTransport()
    const firstKeys = webpush.generateVAPIDKeys()
    const secondKeys = webpush.generateVAPIDKeys()
    const first = createWebPushSender('mailto:first@example.invalid', firstKeys)
    const second = createWebPushSender('mailto:second@example.invalid', secondKeys)

    await first.send(subscription, '', { urgency: 'high', topic: 'session-1' })
    await second.send(subscription, '')
    await first.send(subscription, '')

    expect(requests.map((request) => identity(request).subject)).toEqual([
      'mailto:first@example.invalid',
      'mailto:second@example.invalid',
      'mailto:first@example.invalid',
    ])
    expect(identity(requests[0]).publicKey === firstKeys.publicKey).toBe(true)
    expect(identity(requests[1]).publicKey === secondKeys.publicKey).toBe(true)
    expect(identity(requests[2]).publicKey === firstKeys.publicKey).toBe(true)
    const headers = requests.map((request) => request.headers as Record<string, string | number>)
    expect(headers.map((header) => header.TTL)).toEqual([86_400, 86_400, 86_400])
    expect(headers.map((header) => header.Urgency)).toEqual(['high', 'normal', 'normal'])
    expect(headers.map((header) => header.Topic)).toEqual(['session-1', undefined, undefined])
  })

  it('continues serial delivery after an inactive endpoint times out', async () => {
    vi.useFakeTimers()
    const requests = mockTransport()
    const keys = webpush.generateVAPIDKeys()
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-sender-'))
    const store = PushStore.open(join(root, 'state.json'), () => keys)
    store.upsert({ ...subscription, endpoint: 'https://push.example.test/stalled' })
    store.upsert(subscription)
    const failures = vi.fn()
    const sender = createWebPushSender('mailto:test@example.invalid', keys)
    const report = deliver(store, sender, {}, { onFailure: failures })
    expect(requests.map((request) => request.path)).toEqual(['/stalled'])

    await vi.advanceTimersByTimeAsync(10_000)

    expect(requests.map((request) => request.path)).toEqual(['/stalled', '/healthy'])
    expect(await report).toEqual({ sent: 1, removed: 0, failed: 1 })
    expect(failures).toHaveBeenCalledWith({ status: undefined, kind: 'transient', removed: false })
    expect(store.list()).toHaveLength(2)
  })

  it('rejects invalid VAPID configuration before sending', () => {
    const keys = webpush.generateVAPIDKeys()
    expect(() => createWebPushSender('http://example.invalid', keys)).toThrow(/subject/i)
    expect(() => createWebPushSender('mailto:test@example.invalid', { ...keys, publicKey: 'AQID' })).toThrow(
      /public key/i,
    )
    expect(() => createWebPushSender('mailto:test@example.invalid', { ...keys, privateKey: 'BAUG' })).toThrow(
      /private key/i,
    )
  })
})

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PushStore } from '../src/store.ts'

const keys = { publicKey: 'AQID', privateKey: 'BAUG' }
const subscription = {
  endpoint: 'https://push.example.test/send/one',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true, bodyMode: 'full' as const },
}

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('PushStore', () => {
  it('creates owner-only state and keeps one record per endpoint', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    const path = join(root, 'state.json')
    const store = PushStore.open(path, () => keys)
    store.upsert(subscription)
    store.upsert({ ...subscription, keys: { p256dh: 'AQID', auth: 'AQI' } })
    expect(store.list()).toHaveLength(1)
    expect(JSON.parse(readFileSync(path, 'utf8')).subscriptions).toHaveLength(1)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(PushStore.open(path, () => ({ publicKey: 'wrong', privateKey: 'wrong' })).publicKey).toBe(keys.publicKey)
  })

  it('removes an endpoint and persists the removal', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    const path = join(root, 'state.json')
    const store = PushStore.open(path, () => keys)
    store.upsert(subscription)
    expect(store.remove(subscription.endpoint)).toBe(true)
    expect(store.remove(subscription.endpoint)).toBe(false)
    expect(JSON.parse(readFileSync(path, 'utf8')).subscriptions).toEqual([])
  })
})

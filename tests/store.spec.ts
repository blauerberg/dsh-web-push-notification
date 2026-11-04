import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PushStore } from '../src/store.ts'
import { subscriptionFixture, vapidKeys as keys } from './fixtures.ts'

const subscription = subscriptionFixture()

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
    const mode = statSync(path).mode & 0o777
    if (process.platform === 'win32') {
      // Windows has no POSIX group/other bits, so chmod(0o600) reports 0o666.
      // The portable guarantee left to assert is that the owner can write.
      expect(mode & 0o200).toBe(0o200)
    } else {
      expect(mode).toBe(0o600)
    }
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

  it('persists the suppression policy and opens a file written before it existed', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    const path = join(root, 'state.json')
    const store = PushStore.open(path, () => keys)
    expect(store.settings).toEqual({ suppressWhileActive: true, idleMinutes: 10 })
    store.setSettings({ suppressWhileActive: false, idleMinutes: 2 })
    expect(PushStore.open(path, () => keys).settings).toEqual({ suppressWhileActive: false, idleMinutes: 2 })

    // Every deployment that predates the policy has a state file without it.
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const legacyPath = join(root, 'legacy.json')
    writeFileSync(
      legacyPath,
      JSON.stringify({ version: persisted.version, vapid: persisted.vapid, subscriptions: persisted.subscriptions }),
    )
    expect(PushStore.open(legacyPath, () => keys).settings).toEqual({ suppressWhileActive: true, idleMinutes: 10 })
  })

  it('reads a subscription stored before the subagent preference existed as quiet', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    const legacyPath = join(root, 'legacy.json')
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        vapid: keys,
        subscriptions: [
          {
            endpoint: subscription.endpoint,
            expirationTime: null,
            keys: subscription.keys,
            preferences: { turnCompleted: true, turnFailed: true, approval: true, question: true, bodyMode: 'full' },
          },
        ],
      }),
    )
    // Loading is the only step an existing device performs; no re-subscribe, no
    // user action, and the record still reaches the panel with the field present.
    const [stored] = PushStore.open(legacyPath, () => keys).list()
    expect(stored?.preferences.subagentRuns).toBe(false)
    expect(stored?.preferences.turnCompleted).toBe(true)
  })
})

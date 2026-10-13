import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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

  it('adopts the state a previous version left beside the bundle', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    // The 0.1.1 layout: one file inside the installed package directory, written
    // before the suppression settings existed.
    const legacyPath = join(root, 'old-bundle', 'web-push.json')
    mkdirSync(dirname(legacyPath), { recursive: true })
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
            preferences: {
              turnCompleted: true,
              turnFailed: true,
              approval: true,
              question: true,
              bodyMode: 'summary',
            },
          },
        ],
      }),
    )

    const path = join(root, 'new', 'state.json')
    const store = PushStore.open(path, () => ({ publicKey: 'wrong', privateKey: 'wrong' }), [
      { path: join(root, 'gone.json'), adoptSubscriptions: true },
      { path: legacyPath, adoptSubscriptions: true },
    ])
    expect(store.migratedFrom).toBe(legacyPath)
    expect(store.publicKey).toBe(keys.publicKey)
    expect(store.list()[0]?.preferences.bodyMode).toBe('summary')
    // The adopted state lands at the new path in the current shape, so the next
    // boot reads that file instead of the predecessor again.
    const persisted = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(persisted.vapid).toEqual(keys)
    expect(persisted.settings).toEqual({ suppressWhileActive: true, idleMinutes: 10 })
    expect(
      PushStore.open(path, () => ({ publicKey: 'wrong', privateKey: 'wrong' }), [
        { path: legacyPath, adoptSubscriptions: true },
      ]).migratedFrom,
    ).toBe(undefined)
    // Reading it is the whole job: the predecessor is left where it was.
    expect(existsSync(legacyPath)).toBe(true)
  })

  it('inherits the key pair of a shared predecessor without taking its devices', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    // The file this plugin kept at the Harness home when it ran outside a profile:
    // every profile used to write to it, so its subscription list names devices
    // this profile may not serve, but the pair it holds is the one those devices
    // are bound to.
    const sharedPath = join(root, 'home', 'web-push', 'state.json')
    mkdirSync(dirname(sharedPath), { recursive: true })
    writeFileSync(
      sharedPath,
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

    const path = join(root, 'profile', 'web-push', 'state.json')
    const store = PushStore.open(path, () => ({ publicKey: 'minted', privateKey: 'minted' }), [
      { path: sharedPath, adoptSubscriptions: false },
    ])
    expect(store.publicKey).toBe(keys.publicKey)
    expect(store.privateKey).toBe(keys.privateKey)
    expect(store.migratedFrom).toBe(sharedPath)
    expect(store.list()).toEqual([])
  })

  it('prefers profile-owned keys and devices over a newer shared predecessor', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    const newer = join(root, 'home', 'web-push', 'state.json')
    const older = join(root, 'old-bundle', 'web-push.json')
    mkdirSync(dirname(newer), { recursive: true })
    mkdirSync(dirname(older), { recursive: true })
    writeFileSync(newer, JSON.stringify({ version: 1, vapid: keys, subscriptions: [] }))
    writeFileSync(
      older,
      JSON.stringify({
        version: 1,
        vapid: { publicKey: 'other', privateKey: 'other' },
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

    const path = join(root, 'profile', 'web-push', 'state.json')
    const store = PushStore.open(path, () => ({ publicKey: 'minted', privateKey: 'minted' }), [
      { path: newer, adoptSubscriptions: false },
      { path: older, adoptSubscriptions: true },
    ])
    expect(store.publicKey).toBe('other')
    expect(store.privateKey).toBe('other')
    expect(store.migratedFrom).toBe(older)
    expect(store.list().map((item) => item.endpoint)).toEqual([subscription.endpoint])
  })

  it('starts fresh rather than failing when the predecessor file is unreadable', () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-store-'))
    const brokenPath = join(root, 'broken.json')
    writeFileSync(brokenPath, '{ this is not json')
    const path = join(root, 'state.json')
    const store = PushStore.open(path, () => keys, [
      { path: join(root, 'missing.json'), adoptSubscriptions: true },
      { path: brokenPath, adoptSubscriptions: true },
    ])
    expect(store.migratedFrom).toBeUndefined()
    expect(store.publicKey).toBe(keys.publicKey)
    expect(store.list()).toEqual([])
  })
})

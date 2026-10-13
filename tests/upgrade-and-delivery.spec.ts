import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it } from 'vitest'
import { legacyStoragePaths } from '../src/index.ts'
import { PushStore } from '../src/store.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../src/types.ts'

let root: string | undefined
const previousHome = process.env.DSH_HOME
afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
})

const subscription = {
  endpoint: 'https://push.example.test/review-device',
  expirationTime: null,
  keys: { p256dh: 'AQID', auth: 'BAUG' },
  preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, bodyMode: 'summary' as const },
}

it('preserves the profile-owned keys and device when a newer shared file has unrelated keys', () => {
  root = mkdtempSync(join(tmpdir(), 'push-migration-review-'))
  process.env.DSH_HOME = join(root, 'home')
  const profile = join(root, 'home', 'profiles', 'web')
  const owned = join(profile, 'web-push.json')
  const shared = join(root, 'home', 'web-push', 'state.json')
  const ownedKeys = { publicKey: 'AQID', privateKey: 'BAUG' }
  const sharedKeys = { publicKey: 'BwgJ', privateKey: 'CgsM' }
  for (const [path, keys, devices] of [
    [owned, ownedKeys, [subscription]],
    [shared, sharedKeys, []],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 1, vapid: keys, subscriptions: devices }))
  }
  utimesSync(owned, 1, 1)
  utimesSync(shared, 2, 2)
  const ctx = new Context().extend({ baseUrl: `${pathToFileURL(profile).href}/` })
  ctx.provide('profileContext', { dir: profile })
  const store = PushStore.open(join(profile, 'web-push', 'state.json'), () => ownedKeys, legacyStoragePaths(ctx))
  expect({ publicKey: store.publicKey, endpoints: store.list().map((item) => item.endpoint) }).toEqual({
    publicKey: ownedKeys.publicKey,
    endpoints: [subscription.endpoint],
  })
})

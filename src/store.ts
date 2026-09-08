import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { PushSubscriptionRecord, PushStoreState, VapidKeys } from './types.ts'
import { validateStoreState } from './validation.ts'

/** Generate a new VAPID key pair. Kept as a parameter so storage tests are deterministic. */
export type VapidKeyFactory = () => VapidKeys

export class PushStore {
  private readonly subscriptionsByEndpoint: Map<string, PushSubscriptionRecord>

  private constructor(
    private readonly path: string,
    private readonly vapid: VapidKeys,
    subscriptions: readonly PushSubscriptionRecord[],
  ) {
    this.subscriptionsByEndpoint = new Map(subscriptions.map((subscription) => [subscription.endpoint, subscription]))
  }

  static open(path: string, generateVapidKeys: VapidKeyFactory): PushStore {
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (!existsSync(path)) {
      const vapid = generateVapidKeys()
      const store = new PushStore(path, vapid, [])
      store.persist()
      return store
    }
    assertRegularFile(path)
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const state = validateStoreState(parsed)
    chmodSync(path, 0o600)
    return new PushStore(path, state.vapid, state.subscriptions)
  }

  get publicKey(): string {
    return this.vapid.publicKey
  }

  get privateKey(): string {
    return this.vapid.privateKey
  }

  list(): PushSubscriptionRecord[] {
    return [...this.subscriptionsByEndpoint.values()].map(cloneSubscription)
  }

  upsert(subscription: PushSubscriptionRecord): void {
    const previous = this.subscriptionsByEndpoint.get(subscription.endpoint)
    this.subscriptionsByEndpoint.set(subscription.endpoint, cloneSubscription(subscription))
    try {
      this.persist()
    } catch (error) {
      if (previous === undefined) this.subscriptionsByEndpoint.delete(subscription.endpoint)
      else this.subscriptionsByEndpoint.set(subscription.endpoint, previous)
      throw error
    }
  }

  remove(endpoint: string): boolean {
    const previous = this.subscriptionsByEndpoint.get(endpoint)
    if (previous === undefined) return false
    this.subscriptionsByEndpoint.delete(endpoint)
    try {
      this.persist()
    } catch (error) {
      this.subscriptionsByEndpoint.set(endpoint, previous)
      throw error
    }
    return true
  }

  private persist(): void {
    if (existsSync(this.path)) assertRegularFile(this.path)
    const state: PushStoreState = {
      version: 1,
      vapid: this.vapid,
      subscriptions: this.list(),
    }
    const parent = dirname(this.path)
    const tempDir = mkdtempSync(join(parent, '.dsh-web-push-'))
    const tempPath = join(tempDir, 'state.json')
    try {
      writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' })
      chmodSync(tempPath, 0o600)
      renameSync(tempPath, this.path)
      chmodSync(this.path, 0o600)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  }
}

function assertRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile()) throw new Error(`push storage is not a regular file: ${path}`)
}

function cloneSubscription(subscription: PushSubscriptionRecord): PushSubscriptionRecord {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: { ...subscription.keys },
    preferences: { ...subscription.preferences },
  }
}

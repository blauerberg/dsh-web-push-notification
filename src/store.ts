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
import {
  DEFAULT_SUPPRESSION_SETTINGS,
  type PushSubscriptionRecord,
  type PushStoreState,
  type SuppressionSettings,
  type VapidKeys,
} from './types.ts'
import { validateStoreState } from './validation.ts'

/** Generate a new VAPID key pair. Kept as a parameter so storage tests are deterministic. */
export type VapidKeyFactory = () => VapidKeys

/**
 * A predecessor file to inherit from.
 *
 * `adoptSubscriptions` says whether the subscription list in that file belongs to
 * this profile. A file every profile used to write to names devices this profile
 * may not serve, so only its VAPID key pair is inherited: the pair is the
 * deployment's push identity, and every subscription a browser still holds is
 * bound to the pair that created it.
 */
export interface LegacyStore {
  readonly path: string
  readonly adoptSubscriptions: boolean
}

export class PushStore {
  private readonly subscriptionsByEndpoint: Map<string, PushSubscriptionRecord>

  private suppression: SuppressionSettings

  private constructor(
    private readonly path: string,
    private readonly vapid: VapidKeys,
    subscriptions: readonly PushSubscriptionRecord[],
    suppression: SuppressionSettings,
    private readonly adoptedFrom: string | undefined = undefined,
  ) {
    this.subscriptionsByEndpoint = new Map(subscriptions.map((subscription) => [subscription.endpoint, subscription]))
    this.suppression = { ...suppression }
  }

  /**
   * Open the store at `path`, creating it when nothing is there yet.
   *
   * `legacyStores` are ordered newest first. A readable profile-owned store supplies
   * its keys, subscriptions, and settings. Shared state supplies only its keys when
   * no profile-owned store can be read.
   */
  static open(path: string, generateVapidKeys: VapidKeyFactory, legacyStores: readonly LegacyStore[] = []): PushStore {
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    if (!existsSync(path)) {
      const adopted = PushStore.adopt(path, legacyStores)
      if (adopted !== undefined) return adopted
      const vapid = generateVapidKeys()
      const store = new PushStore(path, vapid, [], { ...DEFAULT_SUPPRESSION_SETTINGS })
      store.persist()
      return store
    }
    assertRegularFile(path)
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    const state = validateStoreState(parsed)
    chmodSync(path, 0o600)
    return new PushStore(path, state.vapid, state.subscriptions, state.settings)
  }

  /**
   * Persist the newest readable profile-owned predecessor, falling back to shared keys.
   * Originals remain available for manual recovery.
   */
  private static adopt(path: string, legacyStores: readonly LegacyStore[]): PushStore | undefined {
    let adopted: { legacy: LegacyStore; state: PushStoreState } | undefined
    for (const legacy of legacyStores) {
      const state = PushStore.readState(legacy.path)
      if (state === undefined) continue
      if (legacy.adoptSubscriptions) {
        adopted = { legacy, state }
        break
      }
      adopted ??= { legacy, state }
    }
    if (adopted === undefined) return undefined
    const { legacy, state } = adopted
    const store = new PushStore(
      path,
      state.vapid,
      legacy.adoptSubscriptions ? state.subscriptions : [],
      legacy.adoptSubscriptions ? state.settings : { ...DEFAULT_SUPPRESSION_SETTINGS },
      legacy.path,
    )
    store.persist()
    return store
  }

  /** A predecessor's state, or undefined when the file is missing or unreadable. */
  private static readState(path: string): PushStoreState | undefined {
    if (!existsSync(path)) return undefined
    try {
      assertRegularFile(path)
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      return validateStoreState(parsed)
    } catch {
      return undefined
    }
  }

  /** Where the state was read from, when this store adopted a predecessor's file. */
  get migratedFrom(): string | undefined {
    return this.adoptedFrom
  }

  /** The preferences a device already chose, for a renewal that carries none. */
  preferencesOf(endpoint: string): PushSubscriptionRecord['preferences'] | undefined {
    const stored = this.subscriptionsByEndpoint.get(endpoint)
    return stored === undefined ? undefined : { ...stored.preferences }
  }

  get publicKey(): string {
    return this.vapid.publicKey
  }

  get privateKey(): string {
    return this.vapid.privateKey
  }

  get settings(): SuppressionSettings {
    return { ...this.suppression }
  }

  /**
   * Replace the account-wide suppression settings. The write happens first: a
   * settings change that cannot be persisted must not look applied, or the
   * panel would show a quiet-forever choice that the next boot forgets.
   */
  setSettings(next: SuppressionSettings): void {
    const previous = this.suppression
    this.suppression = { ...next }
    try {
      this.persist()
    } catch (error) {
      this.suppression = previous
      throw error
    }
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
      settings: this.settings,
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

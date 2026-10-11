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
   * Before this plugin moved its state out of the installed package directory,
   * the file lived beside the bundle and a reinstall replaced it — which rotated
   * the VAPID key and silently orphaned every subscription the browser still had.
   * `legacyStores` are the places that file used to live, newest first.
   *
   * The key pair is inherited from the newest readable predecessor whatever it is,
   * including one whose subscription list is not attributable to this profile: a
   * browser subscription is bound to the pair that created it, so minting a second
   * pair while any predecessor is still there orphans every device at once.
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
   * Read the newest legacy file that holds a valid store and persist it at `path`.
   *
   * A candidate that cannot be read as a store is skipped rather than fatal: the
   * whole point of the move is that a broken predecessor must not stop the plugin
   * from booting, and the original is left in place to be inspected by hand.
   */
  private static adopt(path: string, legacyStores: readonly LegacyStore[]): PushStore | undefined {
    let vapid: VapidKeys | undefined
    let adoptedFrom: string | undefined
    let subscriptions: readonly PushSubscriptionRecord[] | undefined
    let suppression: SuppressionSettings | undefined
    for (const legacy of legacyStores) {
      const state = PushStore.readState(legacy.path)
      if (state === undefined) continue
      if (vapid === undefined) {
        vapid = state.vapid
        adoptedFrom = legacy.path
      }
      // A list only works next to the pair that created it, so a candidate kept
      // for its subscriptions has to carry the pair this store inherits.
      if (legacy.adoptSubscriptions && subscriptions === undefined && sameVapidKeys(state.vapid, vapid)) {
        subscriptions = state.subscriptions
        suppression = state.settings
      }
    }
    if (vapid === undefined) return undefined
    const store = new PushStore(
      path,
      vapid,
      subscriptions ?? [],
      suppression ?? { ...DEFAULT_SUPPRESSION_SETTINGS },
      adoptedFrom,
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

function sameVapidKeys(left: VapidKeys, right: VapidKeys): boolean {
  return left.publicKey === right.publicKey && left.privateKey === right.privateKey
}

function cloneSubscription(subscription: PushSubscriptionRecord): PushSubscriptionRecord {
  return {
    endpoint: subscription.endpoint,
    expirationTime: subscription.expirationTime,
    keys: { ...subscription.keys },
    preferences: { ...subscription.preferences },
  }
}

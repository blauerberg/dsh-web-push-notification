export interface NotificationPreferences {
  readonly turnCompleted: boolean
  readonly turnFailed: boolean
  readonly approval: boolean
  readonly question: boolean
  /**
   * Whether this device wants the row a dispatched subagent's own turn would
   * produce. Off by default: a subagent runs in a session of its own, so its
   * turn would ring a second time for work the session that dispatched it
   * already reports when that session finishes.
   */
  readonly subagentRuns: boolean
  readonly bodyMode: NotificationBodyMode
}

/**
 * The preference keys a payload is gated on. `bodyMode` chooses which body a
 * device receives, and `subagentRuns` filters a whole class of session out of
 * every kind, so neither one is a kind of its own.
 */
export type NotificationKind = Exclude<keyof NotificationPreferences, 'bodyMode' | 'subagentRuns'>

export type NotificationBodyMode = 'full' | 'summary'

/**
 * How hard the Push service should try to reach a device that is asleep.
 *
 * An approval or a question is worthless late, so it goes out at high urgency
 * and waits out no power saving; a finished turn can wait for the next wake-up.
 */
export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high'

/** The Push service's own per-message hints. Both are optional. */
export interface PushHeaders {
  readonly urgency?: PushUrgency
  readonly topic?: string
}

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  turnCompleted: true,
  turnFailed: true,
  approval: true,
  question: true,
  subagentRuns: false,
  bodyMode: 'full',
}

/**
 * Whether a focused page keeps every other device quiet, and how long a page
 * that nobody is touching still counts as attention.
 *
 * Both live in the store rather than in one browser's local storage: the
 * question they answer ("is the user looking at Harness somewhere?") is
 * account-wide, and the phone has to be able to change the answer for the
 * desktop.
 */
export interface SuppressionSettings {
  readonly suppressWhileActive: boolean
  readonly idleMinutes: number
}

/**
 * Ten minutes is what Slack documents for the same judgement, and Discord
 * exposes the identical wait as its "Push Notification Inactive Timeout".
 */
export const DEFAULT_SUPPRESSION_SETTINGS: SuppressionSettings = {
  suppressWhileActive: true,
  idleMinutes: 10,
}

/** Whole minutes only, bounded so no single page can mute a phone for a day. */
export const MIN_IDLE_MINUTES = 1
export const MAX_IDLE_MINUTES = 60

export interface PushSubscriptionRecord {
  readonly endpoint: string
  readonly expirationTime: number | null
  readonly keys: {
    readonly p256dh: string
    readonly auth: string
  }
  readonly preferences: NotificationPreferences
}

export interface VapidKeys {
  readonly publicKey: string
  readonly privateKey: string
}

export interface PushStoreState {
  readonly version: 1
  readonly vapid: VapidKeys
  readonly subscriptions: readonly PushSubscriptionRecord[]
  readonly settings: SuppressionSettings
}

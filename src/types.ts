export interface NotificationPreferences {
  readonly turnCompleted: boolean
  readonly turnFailed: boolean
  readonly approval: boolean
  readonly question: boolean
  readonly bodyMode: NotificationBodyMode
}

export type NotificationKind = Exclude<keyof NotificationPreferences, 'bodyMode'>

export type NotificationBodyMode = 'full' | 'summary'

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  turnCompleted: true,
  turnFailed: true,
  approval: true,
  question: true,
  bodyMode: 'full',
}

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
}

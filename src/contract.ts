import type { NotificationPreferences } from './types.ts'

export interface WebPushConfig {
  readonly publicKey: string
  readonly serviceWorkerUrl: string
  readonly serviceWorkerScope: string
}

export interface PushSubscriptionJson {
  readonly endpoint: string
  readonly expirationTime?: number | null
  readonly keys?: {
    readonly p256dh?: string
    readonly auth?: string
  }
  readonly preferences?: NotificationPreferences
}

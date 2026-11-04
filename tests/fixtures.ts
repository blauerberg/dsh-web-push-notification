import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationPreferences,
  type PushSubscriptionRecord,
} from '../src/types.ts'

export const vapidKeys = { publicKey: 'AQID', privateKey: 'BAUG' }

export function subscriptionFixture(
  endpoint = 'https://push.example.test/send/one',
  preferences: Partial<NotificationPreferences> = {},
): PushSubscriptionRecord {
  return {
    endpoint,
    expirationTime: null,
    keys: { p256dh: 'AQID', auth: 'BAUG' },
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES, ...preferences },
  }
}

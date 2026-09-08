import webpush from 'web-push'
import type { PushSubscriptionRecord, VapidKeys } from './types.ts'

export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: string): Promise<void>
}

export function createWebPushSender(subject: string, keys: VapidKeys): PushSender {
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
  return {
    send: (subscription, payload) =>
      webpush
        .sendNotification(subscription, payload, {
          TTL: 60,
          urgency: 'normal',
        })
        .then(() => undefined),
  }
}

export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys()
}

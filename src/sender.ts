import webpush from 'web-push'
import type { PushHeaders, PushSubscriptionRecord, VapidKeys } from './types.ts'

/**
 * A phone asleep on a desk can be offline for hours, and a Push service
 * discards a message the moment its TTL expires. A 60-second TTL dropped every
 * notification that arrived while the screen was off, which is exactly the
 * case a lock-screen notification exists for.
 */
const PUSH_TTL_SECONDS = 24 * 60 * 60

export interface PushSender {
  send(subscription: PushSubscriptionRecord, payload: string, headers?: PushHeaders): Promise<void>
}

export function createWebPushSender(subject: string, keys: VapidKeys): PushSender {
  webpush.setVapidDetails(subject, keys.publicKey, keys.privateKey)
  return {
    send: (subscription, payload, headers) =>
      webpush
        .sendNotification(subscription, payload, {
          TTL: PUSH_TTL_SECONDS,
          urgency: headers?.urgency ?? 'normal',
          // An absent topic must stay absent: the header has no "none" value.
          ...(headers?.topic === undefined ? {} : { topic: headers.topic }),
        })
        .then(() => undefined),
  }
}

export function generateVapidKeys(): VapidKeys {
  return webpush.generateVAPIDKeys()
}

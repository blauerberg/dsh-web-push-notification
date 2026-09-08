import type { NotificationKind, PushSubscriptionRecord } from './types.ts'
import type { PushSender } from './sender.ts'
import type { PushStore } from './store.ts'

export interface DeliveryReport {
  readonly sent: number
  readonly removed: number
  readonly failed: number
}

export type PushPayloadFactory = (subscription: PushSubscriptionRecord) => unknown

/** Aggregate counters keep Push endpoints out of route responses and logs. */
export async function deliver(
  store: PushStore,
  sender: PushSender,
  payload: unknown,
  kind?: NotificationKind,
  onFailure?: (status: number | undefined) => void,
  payloadFor?: PushPayloadFactory,
): Promise<DeliveryReport> {
  const serializedPayload = JSON.stringify(payload)
  if (serializedPayload === undefined) throw new Error('push payload is not JSON-serializable')
  let sent = 0
  let removed = 0
  let failed = 0
  for (const subscription of store.list()) {
    if (kind !== undefined && !subscription.preferences[kind]) continue
    try {
      const serialized = payloadFor === undefined ? serializedPayload : JSON.stringify(payloadFor(subscription))
      if (serialized === undefined) throw new Error('push payload is not JSON-serializable')
      await sender.send(subscription, serialized)
      sent++
    } catch (error) {
      const status = errorStatus(error)
      onFailure?.(status)
      if (status === 404 || status === 410) {
        if (store.remove(subscription.endpoint)) removed++
      } else {
        failed++
      }
    }
  }
  return { sent, removed, failed }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

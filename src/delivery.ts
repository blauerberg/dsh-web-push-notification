import { pushHeadersOf } from './notification.ts'
import type { NotificationKind, PushSubscriptionRecord } from './types.ts'
import type { PushSender } from './sender.ts'
import type { PushStore } from './store.ts'

export interface DeliveryReport {
  readonly sent: number
  readonly removed: number
  readonly failed: number
}

export type PushPayloadFactory = (subscription: PushSubscriptionRecord) => unknown

/**
 * Why a send failed, because only one kind of failure is worth trying again.
 *
 * `gone` and `credentials` both describe a record that no later attempt can
 * reach: the endpoint is gone, or the Push service refuses the VAPID key pair
 * this deployment signs with. `transient` covers everything else - a network
 * error, a service outage, a rate limit - where the same record may well work on
 * the next event.
 */
export type DeliveryFailureKind = 'gone' | 'credentials' | 'transient'

export interface DeliveryFailure {
  readonly status: number | undefined
  readonly kind: DeliveryFailureKind
  /** Whether this deployment held the record and dropped it as a result. */
  readonly removed: boolean
}

export interface DeliveryOptions {
  /** When set, only subscriptions whose preferences enable this kind receive the payload. */
  readonly kind?: NotificationKind
  /**
   * Extra per-subscription gate, applied beside the kind gate. A payload only
   * some devices asked for - a subagent's own turn, say - is filtered here,
   * because the caller building the payload cannot see one device's choices.
   */
  readonly wants?: (subscription: PushSubscriptionRecord) => boolean
  readonly onFailure?: (failure: DeliveryFailure) => void
  /** Built per subscription, so one device can receive a different body than its peers. */
  readonly payloadFor?: PushPayloadFactory
}

/** Aggregate counters keep Push endpoints out of route responses and logs. */
export async function deliver(
  store: PushStore,
  sender: PushSender,
  payload: unknown,
  options: DeliveryOptions = {},
): Promise<DeliveryReport> {
  const { kind, wants, onFailure, payloadFor } = options
  const serializedPayload = JSON.stringify(payload)
  if (serializedPayload === undefined) throw new Error('push payload is not JSON-serializable')
  let sent = 0
  let removed = 0
  let failed = 0
  for (const subscription of store.list()) {
    if (kind !== undefined && !subscription.preferences[kind]) continue
    if (wants !== undefined && !wants(subscription)) continue
    try {
      const built = payloadFor === undefined ? payload : payloadFor(subscription)
      const serialized = payloadFor === undefined ? serializedPayload : JSON.stringify(built)
      if (serialized === undefined) throw new Error('push payload is not JSON-serializable')
      await sender.send(subscription, serialized, pushHeadersOf(built))
      sent++
    } catch (error) {
      const status = errorStatus(error)
      const failure = failureKind(error, status)
      if (failure === 'transient') {
        failed++
        onFailure?.({ status, kind: failure, removed: false })
        continue
      }
      // A record this deployment no longer has counts for nothing either way:
      // the counters describe the subscriptions this store held, so a record
      // already gone is neither removed again nor a delivery failure.
      const dropped = store.remove(subscription.endpoint)
      if (dropped) removed++
      onFailure?.({ status, kind: failure, removed: dropped })
    }
  }
  return { sent, removed, failed }
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const statusCode = (error as { statusCode?: unknown }).statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

/**
 * Which kind of failure the Push service reported, since the status alone does
 * not decide what to do with the record.
 *
 * 404 and 410 say the endpoint is gone. A 401 or 403 says the service refused
 * this deployment's credentials for THAT subscription, which is what a
 * regenerated VAPID key pair leaves behind: the browser still holds the
 * subscription it made with the previous pair, and every later send is refused
 * the same way, so retrying it on each event rings a dead endpoint forever. The
 * service states that reason in the response body, and the body is the only
 * thing separating it from a credential problem the operator can fix in config -
 * which is why the decision reads the body instead of the status.
 */
function failureKind(error: unknown, status: number | undefined): DeliveryFailureKind {
  if (status === 404 || status === 410) return 'gone'
  if (status !== 401 && status !== 403) return 'transient'
  return CREDENTIALS_REFUSED.test(errorBody(error)) ? 'credentials' : 'transient'
}

/**
 * The wording a Push service uses when the VAPID key pair in the request is not
 * the one the subscription was created with. FCM answers exactly "the VAPID
 * credentials in the authorization header do not correspond to the credentials
 * used to create the subscriptions"; the second pattern covers the same
 * statement phrased as a public-key mismatch.
 */
const CREDENTIALS_REFUSED = /do not correspond|public key mismatch/i

function errorBody(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const body = (error as { body?: unknown }).body
  return typeof body === 'string' ? body : ''
}

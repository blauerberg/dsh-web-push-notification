import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { deliver, type DeliveryFailure } from './delivery.ts'
import {
  notificationForEvent,
  notificationKindForEvent,
  sessionTitleOf,
  type NotificationMessage,
} from './notification.ts'
import { PresenceRegistry } from './presence.ts'
import { createPushRoutes } from './routes.ts'
import { createWebPushSender, generateVapidKeys } from './sender.ts'
import { PushStore } from './store.ts'

export const name = 'dsh-web-push-notification'

export const inject = ['connection', 'webServer', 'sessions']

/** Contact URI a Push service can use to reach the deployment owner. */
export const DEFAULT_VAPID_SUBJECT = 'mailto:dsh@localhost'

/** Cap on a subscription request body: two keys plus preferences is far smaller. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 64 * 1024

/**
 * Every field is optional, and the exported schema is deliberately NOT asserted
 * back onto this interface with `z<Config>`.
 *
 * From cosmokit 1.8.5 on, a schemastery field's output type also carries
 * `Volatile`, the lazy-reference type the config loader resolves, and `Volatile`
 * is a real runtime export the Harness packages require. A required or
 * defaulted scalar field can therefore no longer satisfy `z<Config>`, which is
 * the annotation upstream used. The Loader validates and defaults against the
 * exported schema before `apply` runs, so the plugin reads plain values here and
 * carries its own fallback for each one.
 */
export interface Config {
  vapidSubject?: string
  storagePath?: string
  maxRequestBodyBytes?: number
}

export const Config = z.object({
  vapidSubject: z.string().default(DEFAULT_VAPID_SUBJECT),
  storagePath: z.string(),
  maxRequestBodyBytes: z.natural().min(1024).default(DEFAULT_MAX_REQUEST_BODY_BYTES),
})

/**
 * The profile service the Harness provides inside a profile it launched. Read
 * structurally rather than imported: this plugin has no dependency on the boot
 * package, and the service is simply absent outside a profile.
 */
interface ProfileService {
  readonly name?: string
  readonly dir?: string
}

/** Separate profile state prevents one profile from notifying another's devices. */
export function defaultStoragePath(ctx: Context): string {
  const dir = profileDirectory(ctx)
  return dir === undefined ? dshHomePath('web-push', 'state.json') : join(dir, 'web-push', 'state.json')
}

/** The directory of the profile this process runs in, when it runs in one. */
function profileDirectory(ctx: Context): string | undefined {
  const profile = ctx.get('profileContext') as ProfileService | undefined
  return typeof profile?.dir === 'string' && profile.dir !== '' ? profile.dir : undefined
}

export function apply(ctx: Context, config?: Config): void {
  const subject = config?.vapidSubject ?? DEFAULT_VAPID_SUBJECT
  const storagePath = config?.storagePath ?? defaultStoragePath(ctx)
  const maxRequestBodyBytes = config?.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  const store = PushStore.open(storagePath, generateVapidKeys)
  const presence = new PresenceRegistry()
  const sender = createWebPushSender(subject, {
    publicKey: store.publicKey,
    privateKey: store.privateKey,
  })
  /**
   * One warning per failed send, with the case worth acting on spelled out. A
   * subscription the Push service refuses this deployment's key pair for can
   * never be delivered to again, so the record is dropped and that device has to
   * enable Web Push once more; without the sentence, the log says only that
   * something was refused.
   */
  const onDeliveryFailure = (failure: DeliveryFailure): void => {
    const status = failure.status === undefined ? '' : ` (${String(failure.status)})`
    const reason =
      failure.kind === 'credentials'
        ? `: the Push service refused this deployment's VAPID key pair for a saved subscription${failure.removed ? ', which was removed; enable Web Push again to renew it' : ''}`
        : failure.kind === 'gone'
          ? `: a saved subscription had expired${failure.removed ? ' and was removed' : ''}`
          : ''
    ctx.logger.warn(new Error(`dsh-web-push-notification: delivery failed${status}${reason}`))
  }
  const routes = createPushRoutes({
    store,
    sender,
    presence,
    maxRequestBodyBytes,
    requestRejection: (request) => ctx.connection.requestRejection(request),
    onDeliveryFailure,
  })
  ctx.effect(() => {
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'dsh-web-push-notification: routes')
  ctx.effect(() => {
    const dispose = ctx.on('session/event', (session: Session, event: SessionEvent) => {
      if (notificationKindForEvent(event) === undefined) return
      // A page already in front of the user shows this change, so ringing every
      // other device about it is noise. Both halves are the user's choice in
      // Settings: they can drop the quiet period, or shorten how long an
      // untouched page keeps claiming their attention. The settings test button
      // deliberately bypasses this: a test is a request for a notification, not
      // a report.
      if (store.settings.suppressWhileActive && presence.anyActive()) return
      const events = session.snapshotEvents()
      const sessionTitle = sessionTitleOf(events)
      const sessionId = String(session.id)
      const summary = notificationForEvent(sessionId, event, { bodyMode: 'summary', events, sessionTitle })
      if (summary === undefined) return
      let full: NotificationMessage | undefined
      // A dispatched subagent runs in a session of its own, so its turn would
      // ring a second time for work the session that dispatched it reports when
      // that session finishes. Each device chooses whether it still wants it.
      const runsItself = session.header.origin === 'subagent'
      void deliver(store, sender, summary, {
        kind: summary.kind,
        wants: runsItself ? (subscription) => subscription.preferences.subagentRuns : undefined,
        onFailure: onDeliveryFailure,
        payloadFor: (subscription) => {
          if (subscription.preferences.bodyMode === 'summary') return summary
          full ??= notificationForEvent(sessionId, event, { bodyMode: 'full', events, sessionTitle }) ?? summary
          return full
        },
      }).catch((error) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    })
    return dispose
  }, 'dsh-web-push-notification: session notifications')
}

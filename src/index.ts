import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { deliver } from './delivery.ts'
import { notificationForEvent } from './notification.ts'
import { createPushRoutes } from './routes.ts'
import { createWebPushSender, generateVapidKeys } from './sender.ts'
import { PushStore } from './store.ts'

export const name = 'dsh-web-push-notification'

export const inject = ['connection', 'webServer', 'sessions']

export interface Config {
  vapidSubject: string
  storagePath: string
  maxRequestBodyBytes: number
}

export const Config: z<Config> = z.object({
  vapidSubject: z.string().required(),
  storagePath: z.string().required(),
  maxRequestBodyBytes: z
    .natural()
    .min(1024)
    .default(64 * 1024),
})

export function apply(ctx: Context, config?: Config): void {
  const resolved = Config(config)
  const store = PushStore.open(resolved.storagePath, generateVapidKeys)
  const sender = createWebPushSender(resolved.vapidSubject, {
    publicKey: store.publicKey,
    privateKey: store.privateKey,
  })
  const onDeliveryFailure = (status: number | undefined): void => {
    ctx.logger.warn(
      new Error(`dsh-web-push-notification: delivery failed${status === undefined ? '' : ` (${String(status)})`}`),
    )
  }
  const routes = createPushRoutes({
    store,
    sender,
    maxRequestBodyBytes: resolved.maxRequestBodyBytes,
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
      const events = session.snapshotEvents()
      const summary = notificationForEvent(String(session.id), event, { bodyMode: 'summary', events })
      if (summary === undefined) return
      void deliver(
        store,
        sender,
        summary,
        summary.kind,
        onDeliveryFailure,
        (subscription) =>
          notificationForEvent(String(session.id), event, {
            bodyMode: subscription.preferences.bodyMode,
            events,
          }) ?? summary,
      ).catch((error) => {
        ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
      })
    })
    return dispose
  }, 'dsh-web-push-notification: session notifications')
}

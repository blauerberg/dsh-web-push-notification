import { readFileSync } from 'node:fs'
import type { ServerResponse, IncomingMessage } from 'node:http'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  PRESENCE_PATH,
  SETTINGS_PATH,
  WEB_PUSH_ROUTE_PREFIX,
  type PresenceReportResponse,
  type WebPushConfig,
} from './contract.ts'
import { deliver, type DeliveryFailure } from './delivery.ts'
import { HttpError, readJson, sendJson, sendText } from './http.ts'
import type { PresenceRegistry } from './presence.ts'
import type { PushSender } from './sender.ts'
import { SERVICE_WORKER_SOURCE } from './service-worker.ts'
import type { PushStore } from './store.ts'
import {
  declaresPreferences,
  validateEndpoint,
  validatePresence,
  validatePreviousEndpoint,
  validateSettings,
  validateSubscription,
  validateTestMessage,
} from './validation.ts'

export const ROUTE_PREFIX = WEB_PUSH_ROUTE_PREFIX
export const CONFIG_PATH = `${ROUTE_PREFIX}/config`
export const SERVICE_WORKER_PATH = `${ROUTE_PREFIX}/sw.js`
/** A disjoint scope prevents this worker from controlling application pages. */
export const SERVICE_WORKER_SCOPE = `${ROUTE_PREFIX}/`
/** Large icon the browser renders in the notification's icon slot. */
export const NOTIFICATION_ICON_PATH = `${ROUTE_PREFIX}/notification-icon.png`
/** Monochrome silhouette the browser tints for the status bar. */
export const NOTIFICATION_BADGE_PATH = `${ROUTE_PREFIX}/notification-badge.png`
const SUBSCRIBE_PATH = `${ROUTE_PREFIX}/subscribe`
const UNSUBSCRIBE_PATH = `${ROUTE_PREFIX}/unsubscribe`
const TEST_PATH = `${ROUTE_PREFIX}/test`

export interface PushRouteOptions {
  readonly store: PushStore
  readonly sender: PushSender
  readonly presence: PresenceRegistry
  readonly maxRequestBodyBytes: number
  readonly requestRejection: HostConnectionHandle['requestRejection']
  readonly onDeliveryFailure?: (failure: DeliveryFailure) => void
}

export function createPushRoutes(options: PushRouteOptions): WebRoute[] {
  const method =
    (expected: string, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): WebRoute['handler'] =>
    async (req, res) => {
      const rejection = options.requestRejection(req)
      if (rejection !== undefined) {
        sendText(res, rejection, rejection === 401 ? 'unauthorized' : 'forbidden', 'text/plain; charset=utf-8')
        return
      }
      if (req.method !== expected) {
        sendText(res, 405, 'method not allowed', 'text/plain; charset=utf-8')
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        const message = error instanceof HttpError ? error.message : 'internal server error'
        sendJson(res, status, { error: message })
      }
    }

  return [
    {
      kind: 'exact',
      path: CONFIG_PATH,
      handler: method('GET', async (_req, res) => {
        const config: WebPushConfig = {
          publicKey: options.store.publicKey,
          serviceWorkerUrl: SERVICE_WORKER_PATH,
          serviceWorkerScope: SERVICE_WORKER_SCOPE,
          suppression: options.store.settings,
        }
        sendJson(res, 200, config)
      }),
    },
    {
      kind: 'exact',
      path: SERVICE_WORKER_PATH,
      handler: method('GET', async (_req, res) => {
        sendText(res, 200, SERVICE_WORKER_SOURCE, 'text/javascript; charset=utf-8')
      }),
    },
    {
      kind: 'exact',
      path: NOTIFICATION_ICON_PATH,
      handler: async (_req, res) => {
        sendPng(res, 'notification-icon.png')
      },
    },
    {
      kind: 'exact',
      path: NOTIFICATION_BADGE_PATH,
      handler: async (_req, res) => {
        sendPng(res, 'notification-badge.png')
      },
    },
    {
      kind: 'exact',
      path: SUBSCRIBE_PATH,
      handler: method('POST', async (req, res) => {
        const subscription = await clientInput(async () => {
          const body = await readJson(req, options.maxRequestBodyBytes)
          const incoming = validateSubscription(body)
          // A rotated subscription arrives without preferences, because the
          // worker cannot read the ones this device chose. Inheriting them from
          // the record it replaces keeps a "summary only" device from being
          // switched back to full bodies by a rotation it never asked for.
          if (declaresPreferences(body)) return incoming
          const previous = validatePreviousEndpoint(body)
          const inherited = previous === undefined ? undefined : options.store.preferencesOf(previous)
          return inherited === undefined ? incoming : { ...incoming, preferences: inherited }
        })
        options.store.upsert(subscription)
        sendJson(res, 200, { ok: true })
      }),
    },
    {
      kind: 'exact',
      path: UNSUBSCRIBE_PATH,
      handler: method('POST', async (req, res) => {
        const endpoint = await clientInput(async () =>
          validateEndpoint(await readJson(req, options.maxRequestBodyBytes)),
        )
        sendJson(res, 200, { removed: options.store.remove(endpoint) })
      }),
    },
    {
      kind: 'exact',
      path: PRESENCE_PATH,
      handler: method('POST', async (req, res) => {
        const report = await clientInput(async () => validatePresence(await readJson(req, options.maxRequestBodyBytes)))
        options.presence.report(report.id, report.active)
        const answer: PresenceReportResponse = { ok: true, suppression: options.store.settings }
        sendJson(res, 200, answer)
      }),
    },
    {
      kind: 'exact',
      path: SETTINGS_PATH,
      handler: method('POST', async (req, res) => {
        const settings = await clientInput(async () =>
          validateSettings(await readJson(req, options.maxRequestBodyBytes)),
        )
        options.store.setSettings(settings)
        sendJson(res, 200, settings)
      }),
    },
    {
      kind: 'exact',
      path: TEST_PATH,
      handler: method('POST', async (req, res) => {
        const message = await clientInput(async () =>
          validateTestMessage(await readJson(req, options.maxRequestBodyBytes, true)),
        )
        const report = await deliver(
          options.store,
          options.sender,
          {
            title: message.title,
            body: message.body,
            tag: `dsh-web-push-test-${String(Date.now())}`,
            url: '/',
          },
          { onFailure: options.onDeliveryFailure },
        )
        sendJson(res, 200, report)
      }),
    },
  ]
}

/** Public artwork sits beside the built bundle: lib/index.js -> ../public. */
const PUBLIC_DIR = new URL('../public/', import.meta.url)

/**
 * Serve one bundled PNG.
 *
 * These routes skip the session gate every state-carrying route uses: the
 * browser fetches a notification's icon on its own, so a rejected request would
 * silently degrade to the grey placeholder disc. The bytes are the app's own
 * artwork, never session content.
 */
function sendPng(res: ServerResponse, fileName: string): void {
  try {
    const body = readFileSync(new URL(fileName, PUBLIC_DIR))
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': body.length,
      // No caching, and no validator either: the artwork is mutable, so a device
      // holding the previous copy would keep drawing the old look for the whole
      // max-age with nothing to revalidate against.
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch {
    sendText(res, 404, 'not found', 'text/plain; charset=utf-8')
  }
}

async function clientInput<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, error instanceof Error ? error.message : 'request is invalid')
  }
}

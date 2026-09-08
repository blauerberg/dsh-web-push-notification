import type { ServerResponse, IncomingMessage } from 'node:http'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { WebPushConfig } from './contract.ts'
import { deliver } from './delivery.ts'
import { HttpError, readJson, sendJson, sendText } from './http.ts'
import type { PushSender } from './sender.ts'
import { SERVICE_WORKER_SOURCE } from './service-worker.ts'
import type { PushStore } from './store.ts'
import { validateEndpoint, validateSubscription } from './validation.ts'

export const ROUTE_PREFIX = '/__dsh/web-push'
export const CONFIG_PATH = `${ROUTE_PREFIX}/config`
export const SERVICE_WORKER_PATH = `${ROUTE_PREFIX}/sw.js`
/** A disjoint scope prevents this worker from controlling application pages. */
export const SERVICE_WORKER_SCOPE = `${ROUTE_PREFIX}/`
const SUBSCRIBE_PATH = `${ROUTE_PREFIX}/subscribe`
const UNSUBSCRIBE_PATH = `${ROUTE_PREFIX}/unsubscribe`
const TEST_PATH = `${ROUTE_PREFIX}/test`

export interface PushRouteOptions {
  readonly store: PushStore
  readonly sender: PushSender
  readonly maxRequestBodyBytes: number
  readonly requestRejection: HostConnectionHandle['requestRejection']
  readonly onDeliveryFailure?: (status: number | undefined) => void
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
      path: SUBSCRIBE_PATH,
      handler: method('POST', async (req, res) => {
        const subscription = await clientInput(async () =>
          validateSubscription(await readJson(req, options.maxRequestBodyBytes)),
        )
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
      path: TEST_PATH,
      handler: method('POST', async (req, res) => {
        await readJson(req, options.maxRequestBodyBytes, true)
        const report = await deliver(
          options.store,
          options.sender,
          {
            title: 'DeepSeek Harness',
            body: 'Web Push is working.',
            tag: `dsh-web-push-test-${String(Date.now())}`,
            url: '/',
          },
          undefined,
          options.onDeliveryFailure,
        )
        sendJson(res, 200, report)
      }),
    },
  ]
}

async function clientInput<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError(400, error instanceof Error ? error.message : 'request is invalid')
  }
}

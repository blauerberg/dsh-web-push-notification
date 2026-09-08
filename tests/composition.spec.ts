import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { apply } from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

describe('real WebServer composition', () => {
  it('serves the config route and Service Worker through node:http', async () => {
    root = mkdtempSync(join(tmpdir(), 'dsh-web-push-composition-'))
    context = new Context()
    context.provide('connection', { requestRejection: () => undefined } as never)
    await context.plugin(WebServer, { host: '127.0.0.1', port: 0 }).await()
    await context
      .plugin(
        { inject: ['connection', 'webServer'], apply },
        {
          vapidSubject: 'mailto:test@example.invalid',
          storagePath: join(root, 'state.json'),
          maxRequestBodyBytes: 1024,
        },
      )
      .await()

    const base = `http://127.0.0.1:${String(context.webServer.port)}`
    const config = await fetch(`${base}/__dsh/web-push/config`)
    expect(config.status).toBe(200)
    expect(await config.json()).toMatchObject({
      serviceWorkerUrl: '/__dsh/web-push/sw.js',
      serviceWorkerScope: '/__dsh/web-push/',
    })
    const worker = await fetch(`${base}/__dsh/web-push/sw.js`)
    expect(worker.status).toBe(200)
    expect(await worker.text()).toContain('showNotification')
  }, 30_000)
})

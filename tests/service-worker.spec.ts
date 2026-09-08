import { describe, expect, it } from 'vitest'
import { SERVICE_WORKER_SOURCE } from '../src/service-worker.ts'

describe('Service Worker source', () => {
  it('always displays push payloads and handles same-origin clicks without caching the app', () => {
    expect(SERVICE_WORKER_SOURCE).toContain('showNotification')
    expect(SERVICE_WORKER_SOURCE).toContain('notificationclick')
    expect(SERVICE_WORKER_SOURCE).toContain('dsh-web-push/open-session')
    expect(SERVICE_WORKER_SOURCE).toContain('openWindow')
    expect(SERVICE_WORKER_SOURCE).not.toContain('caches.open')
  })
})

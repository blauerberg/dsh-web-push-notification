import type { NotificationPreferences, SuppressionSettings } from './types.ts'

export interface WebPushConfig {
  readonly publicKey: string
  readonly serviceWorkerUrl: string
  readonly serviceWorkerScope: string
  readonly suppression: SuppressionSettings
}

export interface PushSubscriptionJson {
  readonly endpoint: string
  readonly expirationTime?: number | null
  readonly keys?: {
    readonly p256dh?: string
    readonly auth?: string
  }
  readonly preferences?: NotificationPreferences
  /**
   * Endpoint this registration replaces, set by the Service Worker when the
   * browser rotates a subscription. The server copies the replaced record's
   * preferences when the request carries none of its own.
   */
  readonly previousEndpoint?: string
}

/**
 * Route prefix shared with the browser bundle. It lives here rather than in
 * routes.ts because that module imports node:fs, and the client bundle must
 * never pull a Node built-in into the page.
 */
export const WEB_PUSH_ROUTE_PREFIX = '/__dsh/web-push'

/** Where a live page reports whether it is focused, visible and recently used. */
export const PRESENCE_PATH = `${WEB_PUSH_ROUTE_PREFIX}/presence`

/** Where the settings panel reads and writes the account-wide suppression policy. */
export const SETTINGS_PATH = `${WEB_PUSH_ROUTE_PREFIX}/settings`

/**
 * A presence report answers with the policy it was judged against, so an open
 * page adopts a changed idle window on its next heartbeat instead of needing a
 * reload.
 */
export interface PresenceReportResponse {
  readonly ok: true
  readonly suppression: SuppressionSettings
}

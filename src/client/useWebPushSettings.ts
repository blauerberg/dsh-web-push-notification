import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getSubscription,
  loadConfig,
  reconcileSubscription,
  refreshServiceWorker,
  registerSubscription,
  removeSubscription,
  renewSubscription,
  saveSuppression,
  sendTest,
} from './api.ts'
import { readPreferences, writePreferences } from './preferences.ts'
import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences, type SuppressionSettings } from '../types.ts'

export type Status = 'loading' | 'unsupported' | 'insecure-context' | 'default' | 'denied' | 'granted' | 'subscribed'

interface SettingsState {
  readonly status: Status
  readonly busy: boolean
  readonly message?: string
  readonly preferences: NotificationPreferences
  readonly suppression?: SuppressionSettings
}

type UpdateState = (patch: Partial<SettingsState>) => void

export function useWebPushSettings() {
  const [state, setState] = useState<SettingsState>({
    status: 'loading',
    busy: false,
    preferences: { ...DEFAULT_NOTIFICATION_PREFERENCES },
  })
  const lifetime = useRef<AbortController>()
  const update = useCallback((signal: AbortSignal, patch: Partial<SettingsState>): void => {
    if (!signal.aborted) setState((current) => ({ ...current, ...patch }))
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    lifetime.current = controller
    const preferences = readPreferences()
    update(signal, { preferences })
    const capability = browserCapability()
    if (capability !== undefined) update(signal, { status: capability })
    else {
      void (async () => {
        try {
          const config = await loadConfig()
          if (signal.aborted) return
          update(signal, { suppression: config.suppression })
          await refreshServiceWorker(config)
          if (signal.aborted) return
          const subscription = await reconcileSubscription(config, preferences, signal)
          if (signal.aborted) return
          update(signal, {
            status: subscription === 'registered' ? 'subscribed' : Notification.permission,
            message:
              subscription === 'mismatched'
                ? 'The host Web Push key changed. Enable notifications again to renew this subscription.'
                : undefined,
          })
        } catch (error) {
          if (!signal.aborted) update(signal, { status: Notification.permission, message: errorMessage(error) })
        }
      })()
    }
    return () => controller.abort()
  }, [update])

  async function run(operation: (update: UpdateState, signal: AbortSignal) => Promise<void>): Promise<void> {
    const signal = lifetime.current?.signal
    if (signal === undefined || signal.aborted) return
    const publish: UpdateState = (patch) => update(signal, patch)
    publish({ busy: true, message: undefined })
    try {
      await operation(publish, signal)
    } catch (error) {
      publish({ message: errorMessage(error) })
    } finally {
      publish({ busy: false })
    }
  }

  const enable = (): Promise<void> =>
    run(async (publish) => {
      if (browserCapability() !== undefined) throw new Error('Web Push is unavailable in this browser context.')
      let permission = Notification.permission
      if (permission === 'default') permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        publish({ status: permission })
        throw new Error(
          permission === 'denied'
            ? 'Notifications are blocked for this site.'
            : 'Notification permission was not granted.',
        )
      }
      const config = await loadConfig()
      publish({ suppression: config.suppression })
      await renewSubscription(config, state.preferences)
      publish({ status: 'subscribed', message: 'Web Push is enabled.' })
    })

  const disable = (): Promise<void> =>
    run(async (publish) => {
      const subscription = await getSubscription(await loadConfig())
      if (subscription !== null) await removeSubscription(subscription)
      publish({ status: Notification.permission, message: 'Web Push is disabled.' })
    })

  const test = (): Promise<void> =>
    run(async (publish) => {
      const subscription = await getSubscription(await loadConfig())
      const result = await sendTest({ endpoint: subscription?.endpoint })
      const counts = `Test sent: ${String(result.sent)}, removed: ${String(result.removed)}, failed: ${String(result.failed)}.`
      const missing = subscription === null || result.subscriptionRegistered === false
      publish({
        ...(missing ? { status: Notification.permission } : {}),
        message: missing
          ? `${counts} This device is not registered with the host. Enable Web Push again to renew.`
          : result.removed > 0
            ? `${counts} An expired subscription was removed. Re-enable Web Push on the affected device.`
            : counts,
      })
    })

  async function updatePreference<K extends keyof NotificationPreferences>(
    key: K,
    value: NotificationPreferences[K],
  ): Promise<void> {
    const previous = state.preferences
    const next = { ...previous, [key]: value }
    if (state.status !== 'subscribed') {
      const signal = lifetime.current?.signal
      if (signal === undefined || signal.aborted) return
      update(signal, { preferences: next })
      writePreferences(next)
      return
    }
    await run(async (publish, signal) => {
      publish({ preferences: next })
      writePreferences(next)
      try {
        const subscription = await getSubscription(await loadConfig())
        if (subscription === null) throw new Error('The Web Push subscription is no longer available.')
        await registerSubscription(subscription, next)
        publish({ message: 'Notification preferences saved.' })
      } catch (error) {
        if (!signal.aborted) {
          publish({ preferences: previous })
          writePreferences(previous)
        }
        throw error
      }
    })
  }

  const updateSuppression = (next: SuppressionSettings): Promise<void> =>
    run(async (publish) => {
      const previous = state.suppression
      publish({ suppression: next })
      try {
        const suppression = await saveSuppression(next)
        publish({ suppression, message: 'Notification timing saved.' })
      } catch (error) {
        publish({ suppression: previous })
        throw error
      }
    })

  return { ...state, enable, disable, test, updatePreference, updateSuppression }
}

function browserCapability(): Exclude<Status, 'loading' | 'default' | 'denied' | 'granted' | 'subscribed'> | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure-context'
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window))
    return 'unsupported'
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

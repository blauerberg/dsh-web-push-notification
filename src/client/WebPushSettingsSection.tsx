import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Button, IconChevronDownOutline14, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  applicationServerKey,
  loadConfig,
  reconcileSubscription,
  registerSubscription,
  sendTest,
  subscriptionUsesApplicationServerKey,
  unregisterSubscription,
  waitForActiveServiceWorker,
} from './api.ts'
import { readPreferences, writePreferences } from './preferences.ts'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  type NotificationBodyMode,
  type NotificationKind,
  type NotificationPreferences,
} from '../types.ts'

type Status = 'loading' | 'unsupported' | 'insecure-context' | 'default' | 'denied' | 'granted' | 'subscribed'

const EVENT_OPTIONS: readonly {
  readonly key: NotificationKind
  readonly label: string
  readonly description: string
}[] = [
  { key: 'turnCompleted', label: 'Task completed', description: 'Notify when a task finishes successfully.' },
  { key: 'turnFailed', label: 'Task stopped or failed', description: 'Notify when a task stops before completing.' },
  { key: 'approval', label: 'Approval required', description: 'Notify when an action needs your approval.' },
  { key: 'question', label: 'Response required', description: 'Notify when the agent needs an answer.' },
]

const sectionStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: '100%',
  color: 'var(--dsw-alias-label-primary)',
}

const titleStyle: CSSProperties = {
  fontSize: 14,
  fontWeight: 400,
  lineHeight: '22px',
  color: 'var(--dsw-alias-label-primary)',
}

const descriptionStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 400,
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '16px 0',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
}

const rowTextStyle: CSSProperties = {
  display: 'flex',
  flex: 1,
  minWidth: 0,
  flexDirection: 'column',
  gap: 4,
  paddingRight: 48,
}

const selectorFrameStyle: CSSProperties = {
  position: 'relative',
  display: 'inline-flex',
  flex: 'none',
}

const selectorStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 36,
  padding: '0 38px 0 14px',
  border: 0,
  borderRadius: 18,
  appearance: 'none',
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 14,
  lineHeight: '22px',
  cursor: 'pointer',
}

const selectorIconStyle: CSSProperties = {
  position: 'absolute',
  top: '50%',
  right: 14,
  pointerEvents: 'none',
  transform: 'translateY(-50%)',
}

const checkboxStyle: CSSProperties = {
  flex: 'none',
  width: 16,
  height: 16,
  accentColor: 'var(--dsw-alias-state-success-primary)',
}

export function WebPushSettingsSection(_props: PropsRuntime<'settings.section'>): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => ({
    ...DEFAULT_NOTIFICATION_PREFERENCES,
  }))

  const refresh = useCallback(async (currentPreferences: NotificationPreferences): Promise<void> => {
    const capability = browserCapability()
    if (capability !== undefined) {
      setStatus(capability)
      return
    }
    try {
      const config = await loadConfig()
      const subscriptionState = await reconcileSubscription(config, currentPreferences)
      if (subscriptionState === 'mismatched') {
        setStatus(Notification.permission)
        setMessage('The host Web Push key changed. Enable notifications again to renew this subscription.')
        return
      }
      setStatus(subscriptionState === 'registered' ? 'subscribed' : Notification.permission)
    } catch (error) {
      setStatus(Notification.permission)
      setMessage(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    const storedPreferences = readPreferences()
    setPreferences(storedPreferences)
    void refresh(storedPreferences)
  }, [refresh])

  const enable = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      if (browserCapability() !== undefined) throw new Error('Web Push is unavailable in this browser context.')
      let permission = Notification.permission
      if (permission === 'default') permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        setStatus(permission)
        throw new Error(
          permission === 'denied'
            ? 'Notifications are blocked for this site.'
            : 'Notification permission was not granted.',
        )
      }
      const config = await loadConfig()
      const registration = await navigator.serviceWorker.register(config.serviceWorkerUrl, {
        scope: config.serviceWorkerScope,
      })
      await waitForActiveServiceWorker(registration)
      let subscription = await registration.pushManager.getSubscription()
      if (subscription !== null && !subscriptionUsesApplicationServerKey(subscription, config.publicKey)) {
        await unregisterSubscription(subscription.endpoint)
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.publicKey),
      })
      await registerSubscription(subscription, preferences)
      setStatus('subscribed')
      setMessage('Web Push is enabled.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const disable = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      const config = await loadConfig()
      const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerScope)
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription !== undefined && subscription !== null) {
        await unregisterSubscription(subscription.endpoint)
        await subscription.unsubscribe()
      }
      setStatus(Notification.permission)
      setMessage('Web Push is disabled.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const test = async (): Promise<void> => {
    setBusy(true)
    setMessage(undefined)
    try {
      const result = await sendTest()
      setMessage(
        `Test sent: ${String(result.sent)}, removed: ${String(result.removed)}, failed: ${String(result.failed)}.`,
      )
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const updatePreference = async <K extends keyof NotificationPreferences>(
    key: K,
    value: NotificationPreferences[K],
  ): Promise<void> => {
    const previous = preferences
    const next = { ...preferences, [key]: value }
    setPreferences(next)
    writePreferences(next)
    if (status !== 'subscribed') return
    setBusy(true)
    setMessage(undefined)
    try {
      const config = await loadConfig()
      const registration = await navigator.serviceWorker.getRegistration(config.serviceWorkerScope)
      const subscription = await registration?.pushManager.getSubscription()
      if (subscription === undefined || subscription === null)
        throw new Error('The Web Push subscription is no longer available.')
      await registerSubscription(subscription, next)
      setMessage('Notification preferences saved.')
    } catch (error) {
      setPreferences(previous)
      writePreferences(previous)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const enabledDisabled =
    busy || status === 'loading' || status === 'unsupported' || status === 'insecure-context' || status === 'denied'
  const settingsDisabled = busy || status !== 'subscribed'
  const statusColor = statusColorOf(status)

  return (
    <div style={sectionStyle}>
      <h3 style={{ ...titleStyle, margin: 0 }}>Notifications</h3>
      <p style={{ ...descriptionStyle, margin: '4px 0 0' }}>
        Get notified when a task finishes or needs your attention.
      </p>

      <div style={rowStyle}>
        <div style={rowTextStyle}>
          <div style={titleStyle}>Status</div>
          <div style={descriptionStyle}>{statusDescription(status)}</div>
        </div>
        <div
          role="status"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            color: statusColor,
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          <StateDot state={statusState(status)} />
          {statusLabel(status)}
        </div>
      </div>

      <label style={rowStyle}>
        <span style={rowTextStyle}>
          <span style={titleStyle}>Enabled</span>
          <span style={descriptionStyle}>Allow this browser to receive Web Push notifications.</span>
        </span>
        <input
          type="checkbox"
          checked={status === 'subscribed'}
          disabled={enabledDisabled}
          style={checkboxStyle}
          onChange={(event) => {
            void (event.currentTarget.checked ? enable() : disable())
          }}
        />
      </label>

      <div style={{ ...descriptionStyle, marginTop: 16, fontWeight: 600 }}>Notification details</div>
      <div style={rowStyle}>
        <div style={rowTextStyle}>
          <div style={titleStyle}>Notification body</div>
          <div style={descriptionStyle}>
            Full content is the default. Choose summary only to keep session content out of the Push payload.
          </div>
        </div>
        <div style={selectorFrameStyle}>
          <select
            aria-label="Notification body"
            value={preferences.bodyMode}
            disabled={settingsDisabled}
            style={selectorStyle}
            onChange={(event) => {
              void updatePreference('bodyMode', event.currentTarget.value as NotificationBodyMode)
            }}
          >
            <option value="full">Full content</option>
            <option value="summary">Summary only</option>
          </select>
          <span style={selectorIconStyle}>
            <IconChevronDownOutline14 />
          </span>
        </div>
      </div>

      {EVENT_OPTIONS.map((option) => (
        <label key={option.key} style={rowStyle}>
          <span style={rowTextStyle}>
            <span style={titleStyle}>{option.label}</span>
            <span style={descriptionStyle}>{option.description}</span>
          </span>
          <input
            type="checkbox"
            checked={preferences[option.key]}
            disabled={settingsDisabled}
            style={checkboxStyle}
            onChange={(event) => {
              void updatePreference(option.key, event.currentTarget.checked)
            }}
          />
        </label>
      ))}

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
        <div style={{ ...descriptionStyle, fontWeight: 600 }}>Debug</div>
        <div style={{ ...rowStyle, paddingBottom: 0, borderBottom: 0 }}>
          <div style={rowTextStyle}>
            <div style={titleStyle}>Send test notification</div>
            <div style={descriptionStyle}>Send a test notification to every saved subscription.</div>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void test()
            }}
            disabled={busy || status !== 'subscribed'}
          >
            Send test
          </Button>
        </div>
      </div>
      {message === undefined ? null : (
        <p aria-live="polite" style={{ ...descriptionStyle, margin: '12px 0 0' }}>
          {message}
        </p>
      )}
    </div>
  )
}

function browserCapability(): Exclude<Status, 'loading' | 'default' | 'denied' | 'granted' | 'subscribed'> | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return 'insecure-context'
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window))
    return 'unsupported'
  return undefined
}

function statusState(status: Status): StateDotState {
  if (status === 'subscribed') return 'done'
  if (status === 'loading') return 'ongoing'
  if (status === 'default' || status === 'granted') return 'warning'
  return 'error'
}

function statusColorOf(status: Status): string {
  switch (statusState(status)) {
    case 'done':
      return 'var(--dsw-alias-state-success-primary)'
    case 'ongoing':
      return 'var(--dsw-alias-state-business-primary)'
    case 'warning':
      return 'var(--dsw-alias-state-warn-label)'
    case 'error':
      return 'var(--dsw-alias-state-error-primary)'
  }
}

function statusLabel(status: Status): string {
  switch (status) {
    case 'loading':
      return 'checking'
    case 'unsupported':
      return 'unsupported'
    case 'insecure-context':
      return 'insecure context'
    case 'default':
      return 'permission not requested'
    case 'denied':
      return 'denied'
    case 'granted':
      return 'granted'
    case 'subscribed':
      return 'subscribed'
  }
}

function statusDescription(status: Status): string {
  switch (status) {
    case 'loading':
      return 'Checking browser and subscription state.'
    case 'unsupported':
      return 'This browser does not support Web Push.'
    case 'insecure-context':
      return 'HTTPS is required except on localhost.'
    case 'default':
      return 'Notification permission has not been requested.'
    case 'denied':
      return 'Browser notifications are blocked for this site.'
    case 'granted':
      return 'Permission is granted, but Web Push is not enabled.'
    case 'subscribed':
      return 'This browser is subscribed to Web Push.'
  }
}

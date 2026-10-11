import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  applicationServerKey,
  loadConfig,
  reconcileSubscription,
  refreshServiceWorker,
  registerSubscription,
  saveSuppression,
  sendTest,
  unregisterSubscription,
  waitForActiveServiceWorker,
} from './api.ts'
import { readPreferences, writePreferences } from './preferences.ts'
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  DEFAULT_SUPPRESSION_SETTINGS,
  type NotificationBodyMode,
  type NotificationKind,
  type NotificationPreferences,
  type SuppressionSettings,
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

/** Whole minutes, from "stop asking so quickly" to "leave me alone for a while". */
const IDLE_CHOICES = [1, 2, 5, 10, 15, 30] as const

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

const testFieldStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  marginTop: 12,
}

const testInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '8px 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: 8,
  background: 'var(--dsw-alias-bg-module-platform)',
  color: 'var(--dsw-alias-label-primary)',
  font: 'inherit',
  fontSize: 13,
}

export function WebPushSettingsSection(_props: PropsRuntime<'settings.section'>): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string>()
  const [preferences, setPreferences] = useState<NotificationPreferences>(() => ({
    ...DEFAULT_NOTIFICATION_PREFERENCES,
  }))
  // Undefined until the config arrives: the controls stay disabled rather than
  // showing defaults that are not what the server holds.
  const [suppression, setSuppression] = useState<SuppressionSettings>()
  const [testTitle, setTestTitle] = useState('')
  const [testBody, setTestBody] = useState('')

  const refresh = useCallback(async (currentPreferences: NotificationPreferences): Promise<void> => {
    const capability = browserCapability()
    if (capability !== undefined) {
      setStatus(capability)
      return
    }
    try {
      const config = await loadConfig()
      setSuppression(config.suppression)
      await refreshServiceWorker(config)
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
      const subscription = await registration.pushManager.getSubscription()
      // Renew rather than adopt: the key a browser reports for an existing
      // subscription is only what this page last asked for, and it agrees with a
      // stale config as readily as with the current one, while the Push service
      // binds the subscription to the key it actually saw. A subscription the
      // host refuses is only ever repaired by making a new one, so an explicit
      // enable always makes one.
      if (subscription !== null) {
        await unregisterSubscription(subscription.endpoint)
        await subscription.unsubscribe()
      }
      const renewed = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(config.publicKey),
      })
      await registerSubscription(renewed, preferences)
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
      // A blank field keeps the server default, so the button behaves exactly as
      // it did before unless the operator deliberately overrides the copy.
      const result = await sendTest({
        title: testTitle === '' ? undefined : testTitle,
        body: testBody === '' ? undefined : testBody,
      })
      const counts = `Test sent: ${String(result.sent)}, removed: ${String(result.removed)}, failed: ${String(result.failed)}.`
      // A removal is the one outcome worth spelling out: the saved subscription
      // is gone, so the counters alone would leave the panel describing a
      // subscription the host no longer holds. Zero everywhere is the other one:
      // the host holds no subscription at all, which looks like success.
      setMessage(
        result.removed > 0
          ? `${counts} The push service no longer accepts ${result.removed === 1 ? 'a saved subscription' : 'some saved subscriptions'}. Enable Web Push again to renew.`
          : result.sent === 0 && result.failed === 0
            ? `${counts} This device is not registered with the host yet: turn Enabled on for this device and try again.`
            : counts,
      )
      // Reconcile, so the status line and the renewal hint follow the removal
      // instead of waiting for the next time the panel is opened.
      if (result.removed > 0) await refresh(preferences)
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

  /**
   * These two are account settings, not per-device ones, so they are stored by
   * the server and saved whether or not this browser holds a subscription. The
   * server echoes what it kept, which is what the panel then shows.
   */
  const updateSuppression = async (next: SuppressionSettings): Promise<void> => {
    const previous = suppression
    setSuppression(next)
    setBusy(true)
    setMessage(undefined)
    try {
      setSuppression(await saveSuppression(next))
      setMessage('Notification timing saved.')
    } catch (error) {
      setSuppression(previous)
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const enabledDisabled =
    busy || status === 'loading' || status === 'unsupported' || status === 'insecure-context' || status === 'denied'
  const settingsDisabled = busy || status !== 'subscribed'
  const timingDisabled = busy || suppression === undefined
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
            <IconChevronDownOutlineRegular />
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

      <label style={rowStyle}>
        <span style={rowTextStyle}>
          <span style={titleStyle}>Subagent runs</span>
          <span style={descriptionStyle}>
            Notify when a dispatched subagent finishes its own turn. Off, only the session that dispatched it reports
            the outcome.
          </span>
        </span>
        <input
          type="checkbox"
          checked={preferences.subagentRuns}
          disabled={settingsDisabled}
          style={checkboxStyle}
          onChange={(event) => {
            void updatePreference('subagentRuns', event.currentTarget.checked)
          }}
        />
      </label>

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--dsw-alias-border-l2)' }}>
        <div style={{ ...descriptionStyle, fontWeight: 600 }}>While you are using Harness</div>
        <label style={rowStyle}>
          <span style={rowTextStyle}>
            <span style={titleStyle}>Quiet while a Harness page is in front of me</span>
            <span style={descriptionStyle}>
              A page you are looking at, on any device, keeps the others quiet. Turn this off to still be notified while
              you are reading.
            </span>
          </span>
          <input
            type="checkbox"
            checked={suppression?.suppressWhileActive ?? DEFAULT_SUPPRESSION_SETTINGS.suppressWhileActive}
            disabled={timingDisabled}
            style={checkboxStyle}
            onChange={(event) => {
              void updateSuppression({
                suppressWhileActive: event.currentTarget.checked,
                idleMinutes: suppression?.idleMinutes ?? DEFAULT_SUPPRESSION_SETTINGS.idleMinutes,
              })
            }}
          />
        </label>
        <div style={{ ...rowStyle, borderBottom: 0 }}>
          <div style={rowTextStyle}>
            <div style={titleStyle}>Away after</div>
            <div style={descriptionStyle}>
              How long an untouched page still counts as you being there. Typing, clicking and moving the cursor all
              count as attention.
            </div>
          </div>
          <div style={selectorFrameStyle}>
            <select
              aria-label="Away after"
              value={suppression?.idleMinutes ?? DEFAULT_SUPPRESSION_SETTINGS.idleMinutes}
              disabled={timingDisabled || suppression?.suppressWhileActive === false}
              style={selectorStyle}
              onChange={(event) => {
                void updateSuppression({
                  suppressWhileActive:
                    suppression?.suppressWhileActive ?? DEFAULT_SUPPRESSION_SETTINGS.suppressWhileActive,
                  idleMinutes: Number(event.currentTarget.value),
                })
              }}
            >
              {IDLE_CHOICES.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 1 ? '1 minute' : `${String(minutes)} minutes`}
                </option>
              ))}
            </select>
            <span style={selectorIconStyle}>
              <IconChevronDownOutlineRegular />
            </span>
          </div>
        </div>
      </div>

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
        <label style={testFieldStyle}>
          <span style={descriptionStyle}>Title (blank uses the default)</span>
          <input
            type="text"
            value={testTitle}
            placeholder="DeepSeek Harness"
            disabled={busy || status !== 'subscribed'}
            style={testInputStyle}
            onChange={(event) => {
              setTestTitle(event.currentTarget.value)
            }}
          />
        </label>
        <label style={testFieldStyle}>
          <span style={descriptionStyle}>Body (blank uses the default)</span>
          <input
            type="text"
            value={testBody}
            placeholder="Web Push is working."
            disabled={busy || status !== 'subscribed'}
            style={testInputStyle}
            onChange={(event) => {
              setTestBody(event.currentTarget.value)
            }}
          />
        </label>
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

function statusState(status: Status): Exclude<StateDotState, 'idle'> {
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

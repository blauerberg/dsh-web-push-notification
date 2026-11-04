import type { CSSProperties } from 'react'
import {
  Button,
  IconChevronDownOutlineRegular,
  StateDot,
  type StateDotState,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { useWebPushSettings, type Status } from './useWebPushSettings.ts'
import { DEFAULT_SUPPRESSION_SETTINGS, type NotificationBodyMode, type NotificationKind } from '../types.ts'

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

export function WebPushSettingsSection(_props: PropsRuntime<'settings.section'>): JSX.Element {
  const {
    status,
    busy,
    message,
    preferences,
    suppression,
    enable,
    disable,
    test,
    updatePreference,
    updateSuppression,
  } = useWebPushSettings()

  const enabledDisabled =
    busy || status === 'loading' || status === 'unsupported' || status === 'insecure-context' || status === 'denied'
  const settingsDisabled = busy || status !== 'subscribed'
  const timingDisabled = busy || suppression === undefined
  const currentSuppression = suppression ?? DEFAULT_SUPPRESSION_SETTINGS
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
            Also receive notifications from subagents for the event types enabled above.
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
            checked={currentSuppression.suppressWhileActive}
            disabled={timingDisabled}
            style={checkboxStyle}
            onChange={(event) => {
              void updateSuppression({
                ...currentSuppression,
                suppressWhileActive: event.currentTarget.checked,
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
              value={currentSuppression.idleMinutes}
              disabled={timingDisabled || !currentSuppression.suppressWhileActive}
              style={selectorStyle}
              onChange={(event) => {
                void updateSuppression({
                  ...currentSuppression,
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
      </div>
      {message === undefined ? null : (
        <p aria-live="polite" style={{ ...descriptionStyle, margin: '12px 0 0' }}>
          {message}
        </p>
      )}
    </div>
  )
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
      return 'not registered'
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
      return 'Enable Web Push to register this browser with the host.'
    case 'subscribed':
      return 'This browser is subscribed to Web Push.'
  }
}

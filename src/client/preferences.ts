import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '../types.ts'

const STORAGE_KEY = 'dsh-web-push-notification.preferences'

export function readPreferences(): NotificationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
    const value: unknown = JSON.parse(raw)
    if (!isPreferences(value)) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
    return value
  } catch {
    // Private browsing or disabled storage must not prevent Web Push from working.
    return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }
}

export function writePreferences(value: NotificationPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // The host subscription remains authoritative when browser storage is unavailable.
  }
}

function isPreferences(value: unknown): value is NotificationPreferences {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.turnCompleted === 'boolean' &&
    typeof record.turnFailed === 'boolean' &&
    typeof record.approval === 'boolean' &&
    typeof record.question === 'boolean' &&
    (record.bodyMode === 'full' || record.bodyMode === 'summary')
  )
}

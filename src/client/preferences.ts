import { DEFAULT_NOTIFICATION_PREFERENCES, type NotificationPreferences } from '../types.ts'
import { validatePreferences } from '../validation.ts'

const STORAGE_KEY = 'dsh-web-push-notification.preferences'

export function readPreferences(): NotificationPreferences {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return validatePreferences(raw === null ? undefined : JSON.parse(raw))
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

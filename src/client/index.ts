import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import { WebPushSettingsSection } from './WebPushSettingsSection.tsx'
import { startPresenceReporting } from './presence.ts'

export const inject = ['slots', 'uiWorkspace']

const MAX_SESSION_ID_LENGTH = 512

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'web-push-notification',
        order: 30,
        label: 'Notifications',
      },
      WebPushSettingsSection,
    ),
  )
  ctx.effect(() => startPresenceReporting(), 'dsh-web-push-notification: focus presence')
  ctx.effect(() => {
    if (!('serviceWorker' in navigator)) return () => {}
    const openSession = (value: unknown): void => {
      if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH) return
      ctx.uiWorkspace.openSession(value as SessionId)
    }
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isRecord(event.data) || event.data.type !== 'dsh-web-push/open-session') return
      openSession(event.data.sessionId)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    const url = new URL(window.location.href)
    const sessionId = url.searchParams.get('dshSession')
    if (sessionId !== null) {
      openSession(sessionId)
      url.searchParams.delete('dshSession')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage)
    }
  }, 'dsh-web-push-notification: notification navigation')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

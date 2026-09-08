import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WebPushSettingsSection } from './WebPushSettingsSection.tsx'

export const inject = ['slots', 'sessions']

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
  ctx.effect(() => {
    if (!('serviceWorker' in navigator)) return () => {}
    const sessionOpener = createSessionOpener(ctx)
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (!isRecord(event.data) || event.data.type !== 'dsh-web-push/open-session') return
      sessionOpener.open(event.data.sessionId)
    }
    navigator.serviceWorker.addEventListener('message', onMessage)
    const url = new URL(window.location.href)
    const sessionId = url.searchParams.get('dshSession')
    if (sessionId !== null) {
      sessionOpener.open(sessionId)
      url.searchParams.delete('dshSession')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return () => {
      navigator.serviceWorker.removeEventListener('message', onMessage)
      sessionOpener.dispose()
    }
  }, 'dsh-web-push-notification: notification navigation')
}

function createSessionOpener(ctx: ClientContext): { open(value: unknown): void; dispose(): void } {
  const sessions = ctx.sessions as unknown as ClientSessions
  const pending = new Map<SessionId, () => void>()
  return {
    open(value): void {
      if (typeof value !== 'string' || value.length === 0 || value.length > 512) return
      const sessionId = value as SessionId
      if (pending.has(sessionId)) return
      const openWhenListed = (): boolean => {
        if (!sessions.list.getSnapshot().ids.includes(sessionId)) return false
        sessions.open(sessionId)
        return true
      }
      if (openWhenListed() || sessions.list.getSnapshot().phase === 'ready') return
      const onListChange = (): void => {
        const snapshot = sessions.list.getSnapshot()
        if (!snapshot.ids.includes(sessionId) && snapshot.phase !== 'ready') return
        if (snapshot.ids.includes(sessionId)) sessions.open(sessionId)
        pending.get(sessionId)?.()
        pending.delete(sessionId)
      }
      const unsubscribe = sessions.list.subscribe(onListChange)
      pending.set(sessionId, unsubscribe)
    },
    dispose(): void {
      for (const unsubscribe of pending.values()) unsubscribe()
      pending.clear()
    },
  }
}

interface ClientSessions {
  readonly list: {
    getSnapshot(): { readonly ids: readonly SessionId[]; readonly phase: 'pending' | 'ready' }
    subscribe(listener: () => void): () => void
  }
  open(id: SessionId): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

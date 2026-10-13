/**
 * Which Harness pages are in front of the user right now.
 *
 * A Push service cannot be asked whether a tab is focused, so each page reports
 * its own state and the server answers the only question a notification needs:
 * is the user already looking at this UI somewhere. Suppression is deliberately
 * global rather than per device: a page focused on the desktop is just as good
 * a reason not to ring the phone as the phone's own page would be.
 */
export interface PresenceReport {
  readonly id: string
  readonly active: boolean
}

/**
 * Three missed heartbeats. Long enough that one dropped report does not un-mute
 * a phone mid-conversation, short enough that a page killed without a chance to
 * say goodbye stops muting on its own.
 */
export const PRESENCE_TTL_MS = 60_000

interface PresenceEntry {
  readonly active: boolean
  readonly at: number
}

export class PresenceRegistry {
  private readonly clients = new Map<string, PresenceEntry>()

  constructor(
    private readonly ttlMs: number = PRESENCE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  report(id: string, active: boolean): void {
    const at = this.now()
    this.prune(at)
    this.clients.set(id, { active, at })
  }

  /** True while any page is focused, visible, and recently used. */
  anyActive(): boolean {
    const at = this.now()
    this.prune(at)
    for (const entry of this.clients.values()) {
      if (entry.active) return true
    }
    return false
  }

  private prune(at: number): void {
    for (const [id, entry] of this.clients) {
      if (at - entry.at > this.ttlMs) this.clients.delete(id)
    }
  }
}

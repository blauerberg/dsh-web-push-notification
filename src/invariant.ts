/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-web-push-notification'

export const name = 'dsh-web-push-notification-invariant'
export const inject = ['invariants']

/**
 * Route disposal is covered by the webserver companion, while delivery
 * failures are isolated from session state and have no runtime invariant.
 */
const install: InvariantInstaller = () => {}

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */

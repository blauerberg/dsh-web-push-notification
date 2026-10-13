# dsh-web-push-notification

[![CI](https://github.com/blauerberg/dsh-web-push-notification/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/blauerberg/dsh-web-push-notification/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-web-push-notification?logo=npm)](https://www.npmjs.com/package/dsh-web-push-notification)
[![License](https://img.shields.io/github/license/blauerberg/dsh-web-push-notification)](LICENSE)

Receive notifications when a DeepSeek Harness task completes, stops, or needs
your approval or response.

Version 0.2.0 requires DeepSeek Harness 0.2.x, starting with `0.2.0-rc.2`.
Harness 0.1.x is not supported by this version.

## Install

These examples use the `web` profile. Replace `web` with your profile name in
each command and path.

Install the plugin into the profile you want to notify:

```sh
dsh plugin --profile web add dsh-web-push-notification
```

Set the VAPID contact URI in `$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-web-push-notification
  config:
    vapidSubject: 'mailto:admin@example.com'
```

Use your own `mailto:` URI or `https:` URL for `vapidSubject`. This contact
address is independent of the address used to open Harness.

Restart the profile after installation:

```sh
dsh --profile web
```

Open Harness over HTTPS unless you access it through a loopback address. On iOS
and iPadOS, add it to the Home Screen before enabling Web Push. The Harness host
needs outbound access to the browser's push service; it does not need a public
inbound endpoint for push delivery.

Open **Settings → Notifications**, enable Web Push, and use **Send test**.
Optional **Title** and **Body** fields customize only the test notification;
blank fields use the displayed defaults. Test notifications go to all registered
devices and bypass activity suppression.

If a push service rejects an expired subscription or its VAPID credentials, the
host removes that record. **Send test** reports the delivery counts and whether
this device remains registered. Use **Enable Web Push** again on an affected
device to create a subscription with the current keys.

## Notification behavior

Each browser or installed PWA stores its notification preferences separately.
These event types are enabled by default:

- Task completed
- Task stopped or failed
- Approval required
- Response required

**Subagent runs** is off by default. Enable it to receive notifications from
subagent sessions in addition to the parent session.

**Full content** includes the latest response, question, or approval reason.
**Summary only** omits those details from the body. Titles include the event
kind and session name in both modes, for example `Done · Fix the paste bug`.
Bodies convert Markdown to plain text. Push payloads are encrypted to the
subscription's `p256dh` key; the push service receives ciphertext.

Tapping a notification focuses an existing Harness window and opens its session,
or opens a new window. Browsers that support notification actions also show
**Open** and **Dismiss**. Repeated notifications for the same session and event
kind replace the previous row and alert again. Push messages expire after 24
hours; approval, question, and failure messages use high urgency, while completed
turns use normal urgency.

### Activity suppression

Notifications are suppressed while any Harness page is focused, visible, and
recently used, across all devices. A page stops suppressing notifications after
ten minutes without input, or after one minute without a presence report.
Pointer movement counts as activity.

In **Settings → Notifications → While you are using Harness**, disable
suppression or set the idle threshold from one to thirty minutes. These settings
are shared by all devices in the profile. Open pages adopt changes on their next
presence report.

## Storage and upgrades

VAPID keys, subscriptions, and suppression settings are stored in
`$DSH_HOME/profiles/web/web-push/state.json`, outside the profile's installed
package directory. Each profile has its own state. Set `storagePath` in the
plugin configuration to use another location.

On first startup with no state at the default path, the plugin adopts a
readable legacy state file belonging to the profile, including its keys,
subscriptions, and suppression settings. The most recently modified
profile-owned file takes precedence. Legacy candidates include the profile's
`web-push.json` and bundle-local `web-push.json` files.

If no readable profile-owned predecessor exists, the shared
`$DSH_HOME/web-push/state.json` supplies fallback VAPID keys. Its subscriptions
and settings are not imported because their owning profile is unknown. Devices
using the inherited keys register again when their Notifications settings load.
A device using a different key pair must enable Web Push again. Legacy files
remain available for recovery; existing state at the configured path takes
precedence over migration. Setting an explicit `storagePath` disables automatic
legacy adoption.

## Service Worker and endpoints

The worker at `/__dsh/web-push/sw.js` uses scope `/__dsh/web-push/`, so it can
coexist with a root-scope PWA worker. It handles push events and subscription
rotation, has no `fetch` handler, and caches no page content.

Configuration, subscription, presence, settings, and test routes use the
Harness session authentication gate. Subscription endpoints must use HTTPS;
literal private, loopback, and link-local addresses are rejected. DNS names that
resolve to private addresses are not filtered. Authentication restricts access
to these routes; it does not prevent an authenticated caller from submitting
such a DNS name.

Notification artwork is served without session authentication at
`/__dsh/web-push/notification-icon.png` and
`/__dsh/web-push/notification-badge.png`, so browsers can fetch it without an app
cookie. The large icon is transparent to avoid adding another visible icon;
the badge is a monochrome silhouette. Both files derive from the Harness app
mark and are covered by [Third-Party Notices](THIRD_PARTY_NOTICES.md).

## Development

Use the pnpm version declared in `package.json`:

```sh
pnpm install --frozen-lockfile
pnpm run check
```

The check runs formatting, lint, typechecking, unit tests, and the distribution
build. CI also checks against the latest stable Harness release, or the latest
release candidate when no stable release exists.

## License

The project is licensed under [MIT](LICENSE). See
[Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled artwork and runtime
dependency notices.

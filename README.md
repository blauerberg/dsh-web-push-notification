# dsh-web-push-notification

[![License](https://img.shields.io/github/license/blauerberg/dsh-web-push-notification)](LICENSE)

Receive notifications when a DeepSeek Harness task completes, stops, or needs
your approval or response.

This is a local fork. It installs as a Harness bundle and serves its own
narrow-scope Service Worker, so it coexists with a root-scope PWA Service Worker
instead of replacing it, and it works on any HTTPS origin (including a Tailscale
host name) with no public endpoint of its own.

## Install

Install the package directory as a bundle into the profile you want to notify:

```
dsh plugin --profile web install <path-to-this-package>
```

The bundle's `cordis.patch.yml` inserts the plugin and supplies the required
`vapidSubject`:

```yaml
- insert:
    - id: dsh-web-push-notification
      name: dsh-web-push-notification
      config:
        vapidSubject: 'mailto:dsh@localhost'
```

`vapidSubject` is the VAPID contact URI; use either a `mailto:` URI or an
`https:` URL, and replace the placeholder with your own address. It is
independent of the address used to open DeepSeek Harness.

VAPID keys and subscriptions are stored in `web-push/state.json` inside the
profile's own directory (for example
`$DSH_HOME/profiles/web/web-push/state.json`). Two things follow from that
location. The state is outside the profile's package directory, so an upgrade or
reinstall cannot replace it and rotate the VAPID key, silently orphaning every
subscription the browser still believes is active. And it is per profile, so a
second profile's sessions never reach the first profile's browser, which is what
a single file under the Harness home would do. Set `storagePath` in the plugin
configuration only to use another location.

A deployment that runs without a profile keeps its state at
`$DSH_HOME/web-push/state.json`, and the first profile that starts up afterwards
reads the VAPID key pair from that file. A browser subscription is bound to the
pair that created it, so inheriting the pair is what keeps the phones and desktops
that already enabled Web Push ringing. The subscription list is deliberately left
behind, because every profile used to write to that one file and a device in it
may belong to another profile. Each device re-registers itself the next time its
Settings page loads, which needs no action from the user.

Installing a bundle adds a package to the profile, so it needs a Harness
restart before the plugin loads. Restart with `dshw-restart.ps1`.

Open the profile over HTTPS unless you access it through a loopback address. On
iOS and iPadOS, add the profile to the Home Screen before enabling Web Push.

Then open **Settings → Notifications**, enable Web Push, and use **Send test**.

The test button can take optional **Title** and **Body** fields. A blank field is
passed to the server as absent, so the test notification uses the default copy (the
placeholders in those inputs show it); fill one in only to check how a custom title
or body renders on your phone. The real notifications are unaffected by these two
fields.

A subscription can outlive the VAPID key pair it was created with: a state file
that is genuinely gone - a fresh profile with no predecessor to inherit from, or a
deployment whose keys were replaced - leaves the browser holding a subscription
this host no longer signs for. The Push service answers that with
"the VAPID credentials in the authorization header do not correspond to the
credentials used to create the subscriptions", which no retry can fix, so the host
drops the record rather than ringing a dead endpoint on every event. **Send test**
names the removal instead of reporting a bare failure. Enabling Web Push again
renews the subscription: the page unsubscribes the stored one and creates a new
one under the current key pair, rather than reporting the key change as a
permanent failure.

## Notification behavior

Each browser or installed PWA stores its notification settings separately. All
event types are enabled by default:

- Task completed
- Task stopped or failed
- Approval required
- Response required

**Subagent runs** is the exception and is off by default. A dispatched subagent
runs in a session of its own, so its turn would ring a second time for work the
session that dispatched it already reports when that session finishes. Turn it on
per browser when you want the subagent's own completion row as well.

A notification can include full content or a summary:

- **Full content** is the default and includes relevant context such as the
  latest response, question, or approval reason.
- **Summary only** omits session content. Choose it when you do not want
  notification bodies to include detailed task information.

Notification payloads are end-to-end encrypted to the subscription's `p256dh`
key, so the Push service only ever sees ciphertext even in **full** mode.

Tapping a notification focuses an existing Harness window and opens the session
the notification came from, or opens a new window at that session.

While you are already looking at Harness, nothing is pushed. Every open Harness
page reports whether it is focused, visible, and recently used to
`/__dsh/web-push/presence`, and while any page on any device is active, a
notification would only repeat what is on screen. Suppression is deliberately
global rather than per device: a focused window on the desktop is as good a
reason not to ring the phone as the phone's own screen would be.

Two things stop a forgotten page from muting you forever:

- A window nobody has touched for the configured time - ten minutes by default -
  stops counting as attention, so a desktop left open on the far side of the
  room lets the phone ring again.
- The server forgets any page that has not reported for a minute, so a tab that
  dies without a chance to say goodbye stops suppressing on its own.

**Send test** bypasses this deliberately: a test is a request for a
notification, not a report that something happened.

The judgement follows the two clients that have had to solve this exact
problem. Slack resumes mobile notifications "10 minutes after Slack stops
detecting cursor activity" (or a minute after the desktop screen locks), and
Discord exposes the same wait as its **Push Notification Inactive Timeout**. So
cursor movement counts as attention and not just clicks: reading a long answer
under a moving mouse keeps the page active, and going idle is what says you
walked away.

Both halves are yours to change in **Settings -> Notifications -> While you are
using Harness**. The quiet period can be dropped entirely, so a notification
still arrives while you are reading, and the away threshold can be set from one
to thirty minutes. They are account settings rather than per-device ones, since
the question they answer is whether you are looking at Harness anywhere; the
phone can therefore change what the desktop does. An open page adopts a new
threshold on its next report, so no reload is needed.

The notification title leads with what happened and then names the session:
`Done · Fix the paste bug`, `Approval · Ship it`. The kind leads because Android
gives a notification one line and cuts its tail, so a session name first would push
the outcome out of sight; the whole title is clamped to 48 characters on a word
boundary. Until a session has a title, the name is the app's own.

The body is the same content as before, with markdown reduced to plain text:
heading markers, list bullets become `•`, links keep their label and drop the URL,
and bold, italic and inline-code markers go. A phone then shows prose rather than
`**What I did:**`. The result is trimmed to the byte budget as before.

Android also gets two buttons where the browser supports them - **Open** and
**Dismiss** - and a session's repeat notifications replace one row instead of
stacking, because the tag no longer carries the turn number. A replaced row still
alerts, so a second completion is not silent. Chrome on Android reports a maximum of
two actions, and the worker never asks for more.

Each push carries a `Topic` (per session and kind) and an `Urgency`: `high` for an
approval, a question or a failure, `normal` for a completed turn. The topic means a
later completion can never replace a pending approval row; the urgency is the hint a
push service uses when deciding whether to wake a sleeping device.

Every notification carries the app's large icon and a monochrome status-bar
badge, served by this plugin at `/__dsh/web-push/notification-icon.png` and
`/__dsh/web-push/notification-badge.png`. Those two routes answer without the
session gate on purpose: the browser fetches a notification icon by itself, so
demanding the app cookie would silently hand back the grey placeholder disc
browsers draw for a missing icon. The files are artwork derived from the Harness
app mark rather than plugin state, and their license is recorded in
[Third-Party Notices](THIRD_PARTY_NOTICES.md).

The badge is the dsh mark as a white silhouette on transparency, since Chrome
tints it with `PorterDuff SRC_ATOP` over white and only its alpha channel
survives; a coloured badge would lose its contrast in the status bar.

The large icon is deliberately **invisible** - a 192x192 PNG at alpha 1. Android
draws the posting app's own icon in a notification's left slot whether or not the
page supplies one, so any visible large icon adds a second animal beside it, and
no Notification API option can remove the left one. The file has to remain a
valid, correctly sized PNG all the same: Chromium substitutes a grey disc
carrying the origin monogram when the icon is null or zero-width, so deleting the
file, its route, or its dimensions would trade the second icon for a disc rather
than removing it.

`tests/notification-art.spec.ts` decodes both files, fails on a saturated blue
pixel (the brand-blue whale these replaced), and pins the icon's non-zero
dimensions and its invisible pixels.

## Service Worker scope

The worker is served from `/__dsh/web-push/sw.js` and registered with scope
`/__dsh/web-push/`. It deliberately does not claim `/`, so it never evicts a
root-scope worker installed by a PWA plugin. A Push subscription belongs to the
worker that created it and Push events are delivered to that worker regardless
of page scope, so the narrow scope costs nothing.

The worker has no `fetch` handler and caches nothing; page loads stay with
whatever root-scope worker owns the page.

## Changes from upstream 0.1.1

- Push message TTL raised from 60 seconds to 24 hours. A phone asleep for
  longer than a minute previously lost the notification entirely, which is the
  case lock-screen notifications exist for.
- Added a `pushsubscriptionchange` handler, so a subscription the browser
  rotates is re-registered, keeps the preferences that device chose, and has the
  superseded endpoint removed only once the replacement is stored.
- State moved out of the plugin package directory, to `web-push/state.json` under
  the profile directory. The old bundle-local `web-push.json` is adopted on first
  boot, so an upgrading deployment keeps its VAPID key and subscriptions. The
  earlier location for a run without a profile (`$DSH_HOME/web-push/state.json`)
  supplies its VAPID key pair as well, because a subscription is bound to the pair
  that created it; only its subscription list is left alone, since state that every
  profile wrote to cannot be attributed to one of them. Each device re-registers
  itself when its Settings page next loads.
- Subscription endpoints addressing a private, loopback, or link-local host are
  rejected, including the IPv4-mapped IPv6 and trailing-dot spellings of the same
  address. A hostname that merely resolves to a private address is still accepted,
  because the lookup happens later inside the sender; the session gate in front of
  the routes, not this check, is what keeps the sender off an operator's LAN.
- Session navigation uses `uiWorkspace.openSession` instead of the removed
  `sessions.open`, and the icon import uses an export that exists on the
  current client packages.
- Peers narrowed to `^0.2.0-rc.2`, the version this plugin is built and
  typechecked against. The exports it uses (`uiWorkspace.openSession`, the
  current icon export) do not exist in `0.1.5-rc.2`, and neither does
  `profileContext`, so on that version every profile would share one state file.
  `@deepseek-ai/dsh-api-session-controller` is no longer a dependency.
- The build launches TypeScript through the running Node binary, so it works on
  Windows where `node_modules/.bin/tsc` is an executable shell script.
- Notification titles name the session they came from, using the Harness session
  title; the event-kind title remains the fallback before a session has one.
- Notifications carry a large icon and a monochrome status-bar badge, so Chrome
  no longer substitutes its grey letter placeholder disc. The large icon is
  invisible by design, so the notification shows only the app's own icon; see the
  artwork section above.
- The notification tag includes the session id, so two sessions reaching the
  same turn and outcome no longer collapse into one row on the phone.
- Subagent turns no longer notify by default. A subagent runs in a session of its
  own, so its turn rang a second time for work the dispatching session reports
  anyway; **Subagent runs** in **Settings -> Notifications** turns that row back
  on, per device.
- The quiet period and the away threshold are configurable in **Settings ->
  Notifications -> While you are using Harness**, and are stored by the server so
  every device agrees.
- Notifications are suppressed while a Harness page is in front of you, on any
  device: each page reports focus, visibility, and idleness, and an idle or dead
  page stops counting. Pointer movement is attention, not just clicks. The
  **Send test** button still always sends.
- A subscription the Push service refuses this deployment's VAPID key pair for is
  dropped instead of being retried on every session event, and **Send test** says
  the record was removed instead of reporting a bare failure.
- Notification titles lead with the event kind and then the session, clamped to 48
  characters, because Android truncates a one-line title from the right.
- Notification bodies are converted from markdown to plain text before sending, so a
  phone shows prose instead of `**bold**`, link syntax and fence markers.
- Notifications carry **Open** and **Dismiss** actions where the browser supports
  them, never more than `Notification.maxActions`, and a replaced row re-alerts.
- The notification tag no longer includes the turn number, so a session's repeat
  completions replace one row instead of stacking. `Topic` is set per session and
  kind, so a pending approval can never be replaced by a later completion.
- Push messages carry an `Urgency` per event kind: `high` for an approval, a question
  or a failure, `normal` for a completed turn.

## License

The project is licensed under [MIT](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled and runtime dependency notices.

# dsh-web-push-notification

Get browser notifications when a DeepSeek Harness task completes or stops, or
needs your approval or response. Web Push delivers them even when the page is
not open.

## Before you start

- A secure browser context. Use HTTPS, except for local loopback access.
- If another device needs access to the profile, use an HTTPS endpoint. A
  reverse proxy, such as Tailscale Serve, can provide it.

On iOS and iPadOS, install the web profile on the Home Screen before enabling
Web Push. The plugin requests notification permission from its Settings card.

## Install

These examples use the `web` profile. Replace `web` with your profile name in
each command and path.

Install the plugin into the profile you want to notify:

```sh
dsh plugin --profile web add github:blauerberg/dsh-web-push-notification
```

Git installs fetch the source and build `lib/` with the package's `prepare`
script. With pnpm 10 or later, the first install fails until that script is
allowed to run. Add the package key printed by pnpm to the profile's workspace
file (keep any existing `allowBuilds` entries), then rerun the install:

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  dsh-web-push-notification: true
```

The DSH CLI creates this profile-local file when the profile is initialized and
does not overwrite existing edits. It is separate from this repository's
tracked `pnpm-workspace.yaml`; there is no separate override file for
`allowBuilds`.

```sh
dsh plugin --profile web add github:blauerberg/dsh-web-push-notification
```

To build and install a newer Git revision later:

```sh
dsh plugin --profile web update dsh-web-push-notification
```

Add the plugin configuration to
`$DSH_HOME/profiles/web/cordis.patch.yml`:

```yaml
- id: dsh-web-push-notification
  config:
    vapidSubject: 'mailto:admin@example.com'
```

`vapidSubject` is the VAPID contact URI; use either a `mailto:` URI or an
`https:` URL. It is independent of the address used to open DeepSeek Harness.
Subscriptions and VAPID keys are stored in
`$DSH_HOME/profiles/<profile>/web-push.json` by default. Set `storagePath` in
the plugin configuration only to use another location.
The plugin uses the Harness Web profile's browser authentication and trusted
host configuration.

Start the profile:

```sh
dsh --profile web
```

Then open **Settings → Notifications**, enable Web Push, and use **Send test**.

## Notification behavior

Each browser or installed PWA stores its notification settings separately. All
event types are enabled by default:

- Task completed
- Task stopped or failed
- Approval required
- Response required

A notification can include full content or a summary:

- **Full content** is the default and includes relevant context such as the
  latest response, question, or approval reason.
- **Summary only** omits session content. Use it when notification previews
  may be visible on a lock screen or shared display, or when you prefer to
  read the content after returning to DeepSeek Harness.

Selecting a notification opens or focuses DeepSeek Harness and returns to the
session that produced it.

## License

The project is licensed under [MIT](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled and runtime dependency notices.

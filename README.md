# dsh-web-push-notification

Receive notifications from a DeepSeek Harness web profile even when its page
is closed. Notifications cover completed or stopped tasks, approval requests,
and questions that need a response.

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
dsh plugin --profile web add https://github.com/blauerberg/dsh-web-push-notification/releases/latest/download/dsh-web-push-notification.tgz
```

The release tarball contains the built plugin and does not run a build script
during installation.

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

## Choose your notifications

The settings card lets each browser or installed PWA choose which events to
receive; settings are stored per browser or PWA, and all event types are
enabled by default:

- Task completed
- Task stopped or failed
- Approval required
- Response required

You can also choose the notification body:

- **Full content** is the default and includes relevant context such as the
  latest response, question, or approval reason.
- **Summary only** omits session content. Use it when notification previews
  may be visible on a lock screen or shared display, or when you prefer to
  read the content after returning to DeepSeek Harness.

Selecting a notification opens or focuses DeepSeek Harness and returns to the
session that produced it.

## License

The project is licensed under [MIT](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled and runtime dependency notices.

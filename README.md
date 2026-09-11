# dsh-web-push-notification

[![CI](https://github.com/blauerberg/dsh-web-push-notification/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/blauerberg/dsh-web-push-notification/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/dsh-web-push-notification?logo=npm)](https://www.npmjs.com/package/dsh-web-push-notification)
[![License](https://img.shields.io/github/license/blauerberg/dsh-web-push-notification)](LICENSE)

Receive notifications when a DeepSeek Harness task completes, stops, or needs
your approval or response.

## Install

These examples use the `web` profile. Replace `web` with your profile name in
each command and path.

Install the plugin into the profile you want to notify:

```sh
dsh plugin --profile web add dsh-web-push-notification
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

Start the profile:

```sh
dsh --profile web
```

Open the profile over HTTPS unless you access it through a local loopback
address. On iOS and iPadOS, add the profile to the Home Screen before enabling
Web Push.

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
- **Summary only** omits session content. Choose it when you do not want
  notification bodies to include detailed task information.

## License

The project is licensed under [MIT](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled and runtime dependency notices.

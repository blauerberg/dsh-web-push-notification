# dsh-web-push-notification

Get browser notifications when a DeepSeek Harness task completes or stops, or
needs your approval or response. Web Push delivers them even when the page is
not open.

## Install

These examples use the `web` profile. Replace `web` with your profile name in
each command and path.

Install the plugin into the profile you want to notify:

```sh
dsh plugin --profile web add \
  github:blauerberg/dsh-web-push-notification#1ac9f434dbc117866a60fd69dc19ddbb4e16da07
```

Git installs fetch the source and build `lib/` with the package's `prepare`
script. With pnpm 10 or later, the first command may stop because that build is
not allowed. Add the revision-specific key to the profile's workspace file
(keep any existing `allowBuilds` entries):

```yaml
# $DSH_HOME/profiles/web/pnpm-workspace.yaml
allowBuilds:
  'dsh-web-push-notification@https://codeload.github.com/blauerberg/dsh-web-push-notification/tar.gz/1ac9f434dbc117866a60fd69dc19ddbb4e16da07': true
```

The DSH CLI creates this profile-local file when the profile is initialized and
does not overwrite existing edits. It is separate from this repository's
tracked `pnpm-workspace.yaml`; there is no separate override file for
`allowBuilds`.

Save the file, then rerun the install command above. The commit hash used in
both places identifies `v0.1.0`. Installing another revision requires its
commit hash in both places.

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
- **Summary only** omits session content. Use it when notification previews
  may be visible on a lock screen or shared display, or when you prefer to
  read the content after returning to DeepSeek Harness.

Selecting a notification opens or focuses DeepSeek Harness and returns to the
session that produced it.

## License

The project is licensed under [MIT](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for bundled and runtime dependency notices.

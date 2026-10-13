export const SERVICE_WORKER_SOURCE: string = `
const fallback = { title: 'DeepSeek Harness', body: 'A notification is ready.' };

// The browser renders the notification's large icon from this URL and tints the
// badge for the status bar. With no icon it substitutes a grey disc carrying a
// monogram built from the origin's domain, so both assets are served next to
// this worker instead.
const icon = new URL('notification-icon.png', self.location).href;
const badge = new URL('notification-badge.png', self.location).href;

// Web Notifications renders at most Notification.maxActions action buttons and
// silently drops every extra one rather than failing; Chromium reports two. A
// platform that reports no limit is assumed to accept that many rather than
// shipping a row with no way to open it.
const reportedActions = self.Notification ? Number(self.Notification.maxActions) : 0;
const actionLimit = reportedActions > 0 ? Math.min(reportedActions, 2) : 2;
const actions = [
  { action: 'open', title: 'Open' },
  { action: 'dismiss', title: 'Dismiss' },
].slice(0, actionLimit);

// This scope covers no application page, so no navigation ever triggers an
// update check for this worker. Without these handlers a rebuilt worker stays in
// the waiting state and the previous copy keeps handling push events until
// every client it controls closes, which nothing under this scope ever does.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function payloadOf(event) {
  if (!event.data) return fallback;
  try {
    const value = event.data.json();
    if (value && typeof value === 'object') return value;
  } catch (_) {
    // Invalid payloads still produce a visible notification.
  }
  return fallback;
}

self.addEventListener('push', (event) => {
  const value = payloadOf(event);
  const title = typeof value.title === 'string' && value.title !== '' ? value.title : fallback.title;
  const body = typeof value.body === 'string' ? value.body : fallback.body;
  const tag = typeof value.tag === 'string' && value.tag !== '' ? value.tag : undefined;
  const data = {
    url: typeof value.url === 'string' ? value.url : '/',
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
  };
  const options = { body, data, icon, badge };
  if (typeof tag === 'string') {
    options.tag = tag;
    // The tag is stable per session and kind, so a second completion replaces
    // the first row instead of stacking beside it; without renotify that
    // replacement would land silently.
    options.renotify = true;
  }
  if (actions.length > 0) options.actions = actions;
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // "Dismiss" is a close with no navigation: the row goes away and the page
  // stays wherever the user left it.
  if (event.action === 'dismiss') return;
  const raw = event.notification.data && event.notification.data.url;
  let target = self.location.origin + '/';
  try {
    const url = new URL(typeof raw === 'string' ? raw : '/', self.location.origin);
    if (url.origin === self.location.origin) target = url.href;
  } catch (_) {
    // Keep the same-origin root for malformed click data.
  }
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => {
      try { return new URL(client.url).origin === self.location.origin; } catch (_) { return false; }
    });
    const sessionId = event.notification.data && event.notification.data.sessionId;
    if (existing) {
      if (typeof sessionId === 'string' && sessionId !== '') {
        existing.postMessage({ type: 'dsh-web-push/open-session', sessionId });
      }
      return existing.focus();
    }
    return self.clients.openWindow(target);
  }));
});

function base64UrlToBytes(value) {
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // A rejected POST resolves like any other response, so without this a failed
  // registration is indistinguishable from a successful one: the caller would
  // retire a working endpoint in favour of a record the server never stored.
  if (!response.ok) throw new Error(path + ' answered ' + response.status);
  return response;
}

// A browser silently rotates a Push subscription over time. Without this the
// saved endpoint goes stale and delivery stops with no visible symptom, so the
// worker renews itself and retires the endpoint it replaced — but only once the
// replacement is stored.
self.addEventListener('pushsubscriptionchange', (event) => {
  const previous = event.oldSubscription;
  const replaced = previous && typeof previous.endpoint === 'string' ? previous.endpoint : undefined;
  event.waitUntil((async () => {
    try {
      let next = event.newSubscription;
      if (!next) {
        const response = await fetch('/__dsh/web-push/config', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('/__dsh/web-push/config answered ' + response.status);
        const config = await response.json();
        next = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(config.publicKey),
        });
      }
      // The subscription the browser hands over carries no preferences: those
      // live in localStorage, which this worker cannot read. Naming the endpoint
      // being replaced lets the server carry them over instead of falling back
      // to defaults, which would widen a "summary only" device back to full.
      const body = next.toJSON();
      if (replaced !== undefined) body.previousEndpoint = replaced;
      await post('/__dsh/web-push/subscribe', body);
      if (replaced !== undefined && replaced !== next.endpoint) {
        await post('/__dsh/web-push/unsubscribe', { endpoint: replaced });
      }
    } catch (_) {
      // A failed renewal leaves a stale record behind; the settings section
      // reconciles the subscription again on the next visit.
    }
  })());
});
`

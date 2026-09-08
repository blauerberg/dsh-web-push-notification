export const SERVICE_WORKER_SOURCE: string = `
const fallback = { title: 'DeepSeek Harness', body: 'A notification is ready.' };

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
  event.waitUntil(self.registration.showNotification(title, { body, tag, data }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
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
`

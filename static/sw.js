/* Case Organizer service worker.
 *
 * Its only job is to stop the iOS home-screen app from getting stranded.
 *
 * When the Cloudflare tunnel drops a connection the edge answers with its own
 * 502 page. In a browser tab that is a nuisance you fix by pulling to refresh.
 * In a standalone web app container there is no address bar and no reload
 * affordance, and WebKit holds on to that failed navigation, so the app looks
 * permanently dead — surviving even a re-add of the shortcut, because the
 * container is reading WebKit's shared cache rather than the network.
 *
 * So: never let a failed navigation reach the container. Swap it for a page we
 * control, which polls /ping and reloads itself the moment the origin answers.
 *
 * Deliberately NOT an offline-first cache. Nothing about the app is stored, so
 * a stale service worker can never serve a stale app — the worst it can do is
 * show the recovery page a moment too eagerly.
 */

const VERSION = 'caseorg-v1';
const OFFLINE_URL = '/static/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.add(new Request(OFFLINE_URL, { cache: 'reload' })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only top-level page loads. Everything else — API calls, uploads, assets,
  // and any form POST — goes straight to the network untouched, so no request
  // that changes data can ever be replayed or answered from a cache.
  if (req.mode !== 'navigate' || req.method !== 'GET') return;

  event.respondWith(
    fetch(req)
      .then((response) => {
        // 502/503/504 here is the edge telling us it cannot reach the tunnel.
        // That is not a real page, and it is the exact response that poisons
        // the container, so treat it as a failure rather than passing it on.
        if (response.status >= 502 && response.status <= 504) {
          throw new Error('origin unreachable: ' + response.status);
        }
        return response;
      })
      .catch(() => caches.match(OFFLINE_URL, { ignoreSearch: true }))
  );
});

// Escape hatch: postMessage({type:'unregister'}) from the page tears the worker
// down and clears its cache, so a bad deploy can be undone without asking
// anyone to clear Safari's website data.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'unregister') return;
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
});

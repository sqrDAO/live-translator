/**
 * Tombstone service worker. It exists only to retire its predecessor.
 *
 * The production origin used to host a Workbox PWA, and that service worker
 * is still registered and activated in every browser that ever opened it. It
 * serves the old app shell out of `workbox-precache-v2` without consulting
 * the network, so a visitor sees the retired PWA no matter what is deployed —
 * `curl` gets the new site and the browser does not.
 *
 * Deleting `sw.js` does not fix that: a 404 on the script leaves the
 * installed worker in place. The only reliable eviction is to serve a new,
 * byte-different script at the same path. The old worker fetches it on its
 * next update check, installs this, and this then clears every cache,
 * unregisters itself and reloads open pages onto the real site.
 *
 * Keep this file until it is certain no browser still carries the old
 * registration. It is inert once it has run: nothing registers a service
 * worker here any more.
 */

self.addEventListener('install', () => {
  // Do not wait for the old worker's clients to close.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await Promise.all((await caches.keys()).map((key) => caches.delete(key)))
      await self.registration.unregister()
      // Reload whatever is open so the visitor lands on the deployed site
      // rather than the shell this worker just deleted.
      for (const client of await self.clients.matchAll({ type: 'window' })) {
        client.navigate(client.url)
      }
    })(),
  )
})

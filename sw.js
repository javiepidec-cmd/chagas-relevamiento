// =========================================================================
//  SERVICE WORKER  (v6 — Chagas)
// =========================================================================

const CACHE_VERSION = "captura-v10";
const APP_ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./poligonos.js",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://unpkg.com/@turf/turf@6/turf.min.js",
  "https://fonts.googleapis.com/css2?family=Barlow:wght@400;600;700&display=swap"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => {
      return Promise.allSettled(APP_ASSETS.map(url => cache.add(url)));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter(k => k !== CACHE_VERSION && k !== "tiles-osm").map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;
  if (event.request.method !== "GET") return;

  if (url.includes("script.google.com")) {
    event.respondWith(fetch(event.request));
    return;
  }

  if (url.includes("tile.openstreetmap.org")) {
    event.respondWith(
      caches.open("tiles-osm").then(cache =>
        cache.match(event.request).then(hit =>
          hit || fetch(event.request).then(resp => {
            if (resp.ok) cache.put(event.request, resp.clone());
            return resp;
          }).catch(() => hit)
        )
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((hit) => {
      return hit || fetch(event.request).then(resp => {
        if (resp.ok && (url.startsWith(self.location.origin) || url.includes("unpkg.com") || url.includes("fonts.googleapis"))) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(event.request, clone));
        }
        return resp;
      }).catch(() => {
        if (event.request.mode === "navigate") return caches.match("./index.html");
      });
    })
  );
});

// Service worker minimal : rend l'app installable (le téléchargement nécessite toujours internet)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

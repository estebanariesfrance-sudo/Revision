'use strict';

// ============================================================
// Pour publier une mise à jour : change simplement cette valeur
// (v1 -> v2 -> v3...). L'ancien cache sera supprimé automatiquement.
// ============================================================
const VERSION = 'v2';

const PREFIXE = 'revision-';
const CACHE_NAME = PREFIXE + VERSION;

// Tous les chemins sont relatifs à l'emplacement de sw.js (donc à /revision/).
// Chaque nouveau fichier de l'application doit être ajouté ici pour fonctionner hors ligne.
const FICHIERS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './db.js',
  './test-db.html'
];

// Installation : on télécharge tous les fichiers et on les range dans le cache.
// cache: 'reload' évite de récupérer une vieille copie depuis le cache HTTP de GitHub Pages.
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(FICHIERS.map(async (url) => {
      const reponse = await fetch(new Request(url, { cache: 'reload' }));
      if (!reponse.ok) {
        throw new Error('Échec de mise en cache : ' + url + ' (' + reponse.status + ')');
      }
      await cache.put(url, reponse);
    }));
    await self.skipWaiting();
  })());
});

// Activation : on supprime les caches des anciennes versions (uniquement ceux de cette application).
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const noms = await caches.keys();
    await Promise.all(
      noms
        .filter((nom) => nom.startsWith(PREFIXE) && nom !== CACHE_NAME)
        .map((nom) => caches.delete(nom))
    );
    await self.clients.claim();
  })());
});

// Requêtes : le cache d'abord, le réseau seulement si le fichier n'y est pas.
self.addEventListener('fetch', (event) => {
  const requete = event.request;
  if (requete.method !== 'GET') return;
  if (new URL(requete.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const enCache = await cache.match(requete, { ignoreSearch: true });
    if (enCache) return enCache;

    try {
      return await fetch(requete);
    } catch (erreur) {
      if (requete.mode === 'navigate') {
        const accueil = await cache.match('./index.html');
        if (accueil) return accueil;
      }
      return Response.error();
    }
  })());
});

// Permet à la page de connaître le nom du cache actif (affiché à l'écran).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'GET_VERSION' && event.ports && event.ports[0]) {
    event.ports[0].postMessage(CACHE_NAME);
  }
});

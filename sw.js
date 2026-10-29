'use strict';
/* SW для PWA-версии FI Coin: html/api.json — сеть-первым (офлайн — кэш). */
const VER = 'fi-stat-v3';
const CORE = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
    e.waitUntil(caches.open(VER).then(c => c.addAll(CORE)).then(() => self.skipWaiting()).catch(() => { }));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys()
        .then(ks => Promise.all(ks.filter(k => k !== VER).map(k => caches.delete(k))))
        .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    const same = url.origin === location.origin;
    const fonts = url.hostname.includes('jsdelivr') || url.hostname.includes('telegram.org');
    if (!same && !fonts) return;
    e.respondWith((async () => {
        const cache = await caches.open(VER);
        const here = new URL(location.href);
        const freshFirst = same && (url.pathname.endsWith('.html') || url.pathname.endsWith('api.json') || url.pathname === here.pathname);
        if (freshFirst) {
            try {
                const fresh = await fetch(req);
                if (fresh && fresh.ok) cache.put(req, fresh.clone());
                return fresh;
            } catch (_) {
                const hit = await cache.match(req, { ignoreSearch: true });
                return hit || new Response('', { status: 503 });
            }
        }
        const hit = await cache.match(req, { ignoreSearch: true });
        if (hit) return hit;
        try {
            const fresh = await fetch(req);
            if (fresh && (fresh.ok)) cache.put(req, fresh.clone());
            return fresh;
        } catch (_) {
            return new Response('', { status: 504 });
        }
    })());
});

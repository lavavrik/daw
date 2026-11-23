// Cross-origin isolation for hosts that cannot send COOP/COEP headers.
//
// The engine needs SharedArrayBuffer, which browsers only allow when the page
// is cross-origin isolated (Cross-Origin-Opener-Policy: same-origin plus
// Cross-Origin-Embedder-Policy: require-corp). `npm run dev` / `preview` send
// those headers themselves (vite.config.ts), so this worker never registers
// there. On a plain static host, index.html registers it and reloads once; from
// then on it re-serves every response with the headers added.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Chrome throws on this combination; let the browser handle it.
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith(
    fetch(req).then((res) => {
      // Opaque responses (cross-origin no-cors) cannot be rewritten.
      if (res.status === 0) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});

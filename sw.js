/* 서비스 워커: 오프라인 동작 + 업데이트 자동 반영
 * - 같은 사이트 파일: 네트워크 우선(최신 반영), 실패/지연 시 캐시 사용
 * - Chart.js (CDN): 캐시 우선 (한 번 불러오면 오프라인에서도 동작)
 * 앱 파일 구성을 바꾸면 CACHE 이름의 숫자를 올리세요. */
const CACHE = 'mallclimate-v12';
const CORE = [
  './', './index.html', './style.css', './app.js', './usage.js', './config.json',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];
const CDN_HOSTS = ['cdnjs.cloudflare.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function networkFirst(req, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fallback = () =>
      caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
    const timer = setTimeout(() => {
      if (!done) fallback().then((r) => { if (r && !done) { done = true; resolve(r); } });
    }, timeoutMs);
    fetch(req)
      .then((res) => {
        clearTimeout(timer);
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        if (!done) { done = true; resolve(res); }
      })
      .catch(() => {
        clearTimeout(timer);
        if (!done) fallback().then((r) => { done = true; resolve(r || Response.error()); });
      });
  });
}

function cacheFirst(req) {
  return caches.match(req).then((hit) => {
    if (hit) return hit;
    return fetch(req).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
      }
      return res;
    });
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, 3000));
  } else if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(cacheFirst(req));
  }
  // 그 외(예: Google Apps Script)는 서비스 워커가 관여하지 않음
});

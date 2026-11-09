// 앱 설치용 서비스 워커. 항상 최신 화면을 먼저 받아오고, 인터넷이 끊겼을 때만 저장된 화면을 보여줍니다.
const CACHE = 'yeri-shell-v1';
const SHELL = ['./', 'index.html', 'student.js', 'schedule.js', 'style.css', 'firebase-config.js', 'icon-192.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return; // Firebase 등 외부 요청은 건드리지 않음
  e.respondWith(fetch(r).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(r, copy)); }
    return res;
  }).catch(() => caches.match(r).then(m => m || caches.match('./'))));
});

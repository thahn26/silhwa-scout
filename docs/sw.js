// 실화탐사대 휴대폰 앱 — 오프라인에서도 마지막으로 받은 화면·목록을 보여 준다
const CACHE = "silhwa-m-v1";
const SHELL = ["./", "index.html", "m.js", "manifest.webmanifest", "icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 같은 사이트 파일만: 먼저 새로 받고, 안 되면 저장해 둔 것(앱 파일이 바뀌어도 다음 실행에 바로 반영된다)
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" }).then((r) => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(url.pathname.endsWith("feed.json") ? "feed.json" : e.request, copy)); }
      return r;
    }).catch(() => caches.match(url.pathname.endsWith("feed.json") ? "feed.json" : e.request, { ignoreSearch: true }))
  );
});

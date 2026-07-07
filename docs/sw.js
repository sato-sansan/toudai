/* 灯台 Service Worker — オフライン対応（当日分の閲覧・再生）
 *
 * ・アプリシェル（HTML/CSS/JS/manifest/icon）は install 時にプリキャッシュ
 * ・data/audio は「ネット優先→失敗時キャッシュ」。成功時はキャッシュを更新するので、
 *   一度開いた当日分はオフラインでも読める。
 */
var VERSION = "toudai-v1";
var SHELL = VERSION + "-shell";
var CONTENT = VERSION + "-content";

var SHELL_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) { return c.addAll(SHELL_ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys.filter(function (k) { return k.indexOf(VERSION) !== 0; })
            .map(function (k) { return caches.delete(k); })
      );
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  var url = new URL(req.url);
  var isContent = url.pathname.indexOf("/data/") !== -1 ||
                  url.pathname.indexOf("/audio/") !== -1;

  if (isContent) {
    // ネット優先（毎朝の最新を取りに行く）→ 失敗時キャッシュ
    e.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CONTENT).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
  } else {
    // シェルはキャッシュ優先（起動を速く・オフラインで開ける）
    e.respondWith(
      caches.match(req).then(function (cached) {
        return cached || fetch(req);
      })
    );
  }
});

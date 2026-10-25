/* 吴子航的博客 · Service Worker（PWA 离线缓存）
   策略：HTML 网络优先（离线回退缓存）；静态资源缓存优先；
   大贴图 stale-while-revalidate（先给缓存秒开，后台更新）。
   版本号升级时自动清理旧缓存。 */

var CACHE = 'blog-v1';
var CORE = [
  './', './index.html', './archive.html', './tags.html', './about.html',
  './messages.html', './favicon.svg',
  './css/style.css',
  './js/main.js', './js/background.js', './js/solar3d.js',
  './js/tune-panel.js', './js/copilot.js', './js/gesture.js',
  './js/comments.js', './js/float-mode.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(CORE); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
        .map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  var isHTML = e.request.mode === 'navigate' ||
    (url.pathname.endsWith('.html') || url.pathname.endsWith('/'));
  var isBigTex = url.pathname.indexOf('/textures/') >= 0;

  if (isHTML) {
    /* 网络优先，离线回退 */
    e.respondWith(
      fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return r;
      }).catch(function () {
        return caches.match(e.request).then(function (r) {
          return r || caches.match('./');
        });
      })
    );
    return;
  }

  if (isBigTex) {
    /* 贴图：stale-while-revalidate */
    e.respondWith(
      caches.match(e.request).then(function (cached) {
        var fetchP = fetch(e.request).then(function (r) {
          var copy = r.clone();
          caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
          return r;
        }).catch(function () { return cached; });
        return cached || fetchP;
      })
    );
    return;
  }

  /* 其余静态：缓存优先 */
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request).then(function (r) {
        var copy = r.clone();
        caches.open(CACHE).then(function (c) { c.put(e.request, copy); });
        return r;
      });
    })
  );
});

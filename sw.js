const CACHE = 'pembina-rq-v6';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener('activate', e=>{
  e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e=>{
  const url = new URL(e.request.url);
  /* PENTING: hanya tangani file aplikasi sendiri (GET, satu origin).
     Permintaan ke Supabase (login, ambil/simpan data) dibiarkan lewat
     apa adanya, supaya tidak mengganggu proses login/simpan data. */
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(cached=>{
      const fetchPromise = fetch(e.request).then(res=>{
        if(res.ok){
          const copy = res.clone();
          caches.open(CACHE).then(c=>c.put(e.request, copy));
        }
        return res;
      }).catch(()=>cached);
      return cached || fetchPromise;
    })
  );
});

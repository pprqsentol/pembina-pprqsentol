/* ===== Aplikasi Pembina - Roudhotul Qur'an ===== */
/* Dibuat berdasarkan Aplikasi Pondok, khusus untuk pembina: input Absensi & Hafalan,
   plus lihat Riwayat keduanya. Memakai database Supabase yang SAMA dengan Aplikasi
   Pondok (tabel santri/kegiatan/absensi/hafalan), supaya datanya langsung sinkron. */

/* ====== 1. KONFIGURASI SUPABASE ======
   Isi dua baris di bawah ini dengan Project URL dan Publishable Key
   dari Supabase (Settings -> API Keys) -- SAMA seperti punya Aplikasi Pondok. */
const SUPABASE_URL = 'https://hvivddbhacoppkbtiqpe.supabase.co';
const SUPABASE_KEY = 'sb_publishable_BTFxSTrt1vM1seoQaXG_7g_mqYo5aqq';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

/* ====== PASANG APLIKASI (PWA) ======
   Chrome/Edge di Android baru menawarkan pasang otomatis setelah kriteria
   & "skor keterlibatan" browser terpenuhi (kadang butuh beberapa kali
   kunjungan), jadi tombol "Pasang Aplikasi" ini dipasang manual supaya
   pengguna bisa memasang kapan saja tanpa menunggu itu. iOS Safari malah
   sama sekali tidak punya prompt otomatis -- di sana harus lewat menu
   Bagikan, jadi tombolnya diarahkan ke instruksi manual. */
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredInstallPrompt = e;
  document.querySelectorAll('#btnInstallApp, #btnInstallAppTop').forEach(b=> b.style.display = '');
});
window.addEventListener('appinstalled', ()=>{
  deferredInstallPrompt = null;
  document.querySelectorAll('#btnInstallApp, #btnInstallAppTop').forEach(b=> b.style.display = 'none');
});
function isRunningAsInstalledPwa(){
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}
function isIos(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}
async function installApp(){
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.querySelectorAll('#btnInstallApp, #btnInstallAppTop').forEach(b=> b.style.display = 'none');
    return;
  }
  if(isIos()){
    alert('Cara pasang di iPhone/iPad:\n1. Ketuk ikon Bagikan (kotak dengan panah ke atas) di Safari.\n2. Pilih "Tambah ke Layar Utama".\n\nCatatan: harus dibuka lewat Safari, bukan Chrome, supaya opsi ini muncul.');
    return;
  }
  alert('Kalau tombol "Pasang" tidak muncul sendiri: buka menu titik tiga di pojok browser lalu pilih "Instal aplikasi" / "Tambahkan ke layar utama". Pastikan juga aplikasi dibuka lewat alamat HTTPS.');
}
/* Kalau sudah terpasang (dibuka sebagai app, bukan tab browser), sembunyikan
   tombol pasang -- tidak relevan lagi. */
if(isRunningAsInstalledPwa()){
  document.addEventListener('DOMContentLoaded', ()=>{
    document.querySelectorAll('#btnInstallApp, #btnInstallAppTop').forEach(b=> b.style.display = 'none');
  });
} else if(isIos()){
  /* iOS tidak pernah memicu beforeinstallprompt, jadi tombolnya
     ditampilkan dari awal supaya pengguna iPhone tetap dapat instruksi. */
  document.addEventListener('DOMContentLoaded', ()=>{
    document.querySelectorAll('#btnInstallApp, #btnInstallAppTop').forEach(b=> b.style.display = '');
  });
}

/* Mengubah karakter khusus HTML (<, >, &, ", ') jadi bentuk aman sebelum
   ditampilkan, supaya teks bebas-ketik dari pengguna lain (mis. nama santri
   yang diisi admin_pusat) tidak bisa dieksekusi sebagai kode HTML/JS saat
   dirender lewat innerHTML di app ini. */
function escapeHtml(str){
  if(str===null || str===undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ====== 2. MAPPING: nama kolom database <-> nama field aplikasi ====== */
const STATUS_TO_DB = { h: 'Hadir', a: 'Alpha', i: 'Izin' };
const STATUS_FROM_DB = { Hadir: 'h', Alpha: 'a', Izin: 'i', Sakit: 'a' };

function santriRowToApp(r) {
  return {
    id: r.id, nama: r.nama, noInduk: r.no_induk,
    program: r.program || 'Non-Takhossus',
    hafalanAwal: r.hafalan_awal || 0
  };
}

/* Total hafalan berjalan = hafalan awal (sebelum pakai aplikasi) + seluruh hafalan yang diinput lewat aplikasi.
   1 juz = 20 halaman (hitungan internal pondok). */
function totalHafalanSantri(santriId){
  const s = DB.santri.find(x=>x.id===santriId);
  const awal = s ? (s.hafalanAwal||0) : 0;
  const tambahan = DB.hafalan.filter(h=>h.santriId===santriId).reduce((sum,h)=>sum+(h.jumlahHalaman||1),0);
  const total = awal + tambahan;
  return { total, juz: Math.floor(total/20), halaman: total%20 };
}

/* ====== TARGET RAPOR (dipakai untuk penilaian singkat di Riwayat) ====== */
const TARGET_HAFALAN_PER_HARI = 1;
function hariDalamPeriode(from, to){
  const a = new Date(from), b = new Date(to);
  return Math.max(1, Math.round((b-a)/86400000) + 1);
}
function predikatFromPct(pct){
  if(pct>=90) return 'A'; if(pct>=75) return 'B'; if(pct>=60) return 'C'; if(pct>=40) return 'D'; return 'E';
}
function predikatLabel(huruf){
  return {A:'Sangat Baik', B:'Baik', C:'Cukup Baik', D:'Kurang Baik', E:'Kurang'}[huruf] || '-';
}
function nilaiHafalanSantri(santriId, from, to){
  const tambahan = DB.hafalan.filter(h=>h.santriId===santriId && h.tanggal>=from && h.tanggal<=to)
    .reduce((sum,h)=>sum+(h.jumlahHalaman||1),0);
  const hari = hariDalamPeriode(from, to);
  const target = hari * TARGET_HAFALAN_PER_HARI;
  const pct = target>0 ? Math.min(100, Math.round(tambahan/target*100)) : 0;
  return { tambahan, target, hari, pct, predikat: predikatFromPct(pct) };
}
function nilaiAbsensiSantri(santriId, from, to){
  const items = DB.absensi.filter(a=>a.santriId===santriId && a.tanggal>=from && a.tanggal<=to);
  const hadir = items.filter(a=>a.status==='h').length;
  const pct = items.length ? Math.round(hadir/items.length*100) : 0;
  return { hadir, total: items.length, pct, predikat: predikatFromPct(pct) };
}

/* ====== Urutan hafalan pondok ======
   Santri menghafal TIDAK berurutan 1-30, tapi: 29, 30, 1, 2, 3, ... , 28. */
const JUZ_ORDER = [29, 30, ...Array.from({length:28}, (_,i)=>i+1)];
function posisiJuz(juz){ return JUZ_ORDER.indexOf(juz) + 1; }
function juzSetelah(juz){ const p = posisiJuz(juz); return JUZ_ORDER[p % JUZ_ORDER.length]; }
function juzSekarang(santriId){
  const items = DB.hafalan.filter(h=>h.santriId===santriId)
    .slice().sort((a,b)=> a.tanggal===b.tanggal ? String(a.id).localeCompare(String(b.id)) : a.tanggal.localeCompare(b.tanggal));
  if(items.length===0) return { juz: JUZ_ORDER[0], halaman: 0, mulai: true, adaData: false };
  const last = items[items.length-1];
  if((last.halamanSampai||0) >= 20){
    return { juz: juzSetelah(last.juz), halaman: 0, mulai: true, adaData: true, tanggal: last.tanggal };
  }
  return { juz: last.juz, halaman: last.halamanSampai||0, mulai: false, adaData: true, tanggal: last.tanggal };
}
function formatJuzSekarang(santriId){
  const c = juzSekarang(santriId);
  if(!c.adaData) return `Belum mulai (dimulai dari Juz ${c.juz})`;
  if(c.mulai) return `Juz sebelumnya selesai, giliran Juz ${c.juz} (belum ada input)`;
  return `Juz ${c.juz}, halaman ${c.halaman}`;
}

/* ====== 3b. INDEXEDDB (cadangan offline, bukan server utama) ====== */
const IDB_NAME = 'pembinaDB';
const IDB_STORE = 'cadangan';
let OFFLINE_MODE = false;

function idbOpen(){
  return new Promise((resolve, reject)=>{
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = ()=>{ req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = ()=> resolve(req.result);
    req.onerror = ()=> reject(req.error);
  });
}
async function idbSave(data){
  try {
    const db = await idbOpen();
    await new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(data, 'snapshot');
      tx.oncomplete = resolve;
      tx.onerror = ()=> reject(tx.error);
    });
  } catch(e){ console.warn('Gagal simpan cadangan offline:', e); }
}
async function idbLoad(){
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject)=>{
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get('snapshot');
      req.onsuccess = ()=> resolve(req.result || null);
      req.onerror = ()=> reject(req.error);
    });
  } catch(e){ console.warn('Gagal baca cadangan offline:', e); return null; }
}

/* ====== 3. STATE APLIKASI (diisi dari Supabase setelah login) ====== */
let DB = { kegiatan: [], santri: [], absensi: [], hafalan: [] };
let SESSION = null; // { userId, role, program, nama }

async function loadAll() {
  try {
    const [kegiatanRes, santriRes, absensiRes, hafalanRes] = await Promise.all([
      sb.from('kegiatan').select('*').eq('aktif', true).order('nama'),
      sb.from('santri_umum').select('*').eq('aktif', true).order('nama'),
      sb.from('absensi').select('*'),
      sb.from('hafalan').select('*')
    ]);
    if(kegiatanRes.error) throw kegiatanRes.error;
    DB = {
      kegiatan: (kegiatanRes.data || []).map(k => ({ id: k.id, nama: k.nama, programKhusus: k.program_khusus || null })),
      santri: (santriRes.data || []).map(santriRowToApp),
      absensi: (absensiRes.data || []).map(a => ({
        id: a.id, santriId: a.santri_id, kegiatanId: a.kegiatan_id, tanggal: a.tanggal,
        status: STATUS_FROM_DB[a.status] || 'a'
      })),
      hafalan: (hafalanRes.data || []).map(h => ({
        id: h.id, santriId: h.santri_id, tanggal: h.tanggal, juz: h.juz,
        halamanDari: h.halaman_dari, halamanSampai: h.halaman_sampai,
        jumlahHalaman: h.halaman_sampai - h.halaman_dari + 1
      }))
    };
    OFFLINE_MODE = false;
    idbSave(DB);
  } catch(e){
    console.warn('Gagal ambil data dari Supabase, coba pakai cadangan offline:', e);
    const cadangan = await idbLoad();
    if(cadangan){
      DB = cadangan;
      OFFLINE_MODE = true;
    } else {
      throw e;
    }
  }
}

const NAV_ALL = [
  {id:'absensi', label:'Absensi', icon:'&#10003;'},
  {id:'hafalan', label:'Hafalan', icon:'&#128214;'},
  {id:'riwayat', label:'Riwayat', icon:'&#128202;'}
];
/* Menu yang muncul tergantung tugas akun: hafalan -> Hafalan+Riwayat,
   absensi -> Absensi+Riwayat. Kalau tugas tidak diset, tampilkan semua. */
function navForSession(){
  if(SESSION && SESSION.tugas === 'hafalan') return NAV_ALL.filter(i=>i.id!=='absensi');
  if(SESSION && SESSION.tugas === 'absensi') return NAV_ALL.filter(i=>i.id!=='hafalan');
  return NAV_ALL;
}

let currentPage = 'absensi';

/* ---------- LOGIN (email/password via Supabase Auth) ======
   Akun dibuatkan lewat Supabase Auth (mis. hafalan@pprqsentol.com,
   absensi@pprqsentol.com). Setelah login, tugas & nama diambil dari
   tabel `profil_akun` (kolom `tugas`: 'hafalan' atau 'absensi'),
   yang menentukan menu apa saja yang muncul. Santri yang tampil
   TIDAK dibatasi per program -- semua santri terlihat. */

async function loadSessionFromAuth(user) {
  const { data, error } = await sb.from('profil_akun').select('*').eq('id', user.id).single();
  if (error || !data) throw error || new Error('Profil akun tidak ditemukan.');
  return { userId: user.id, email: user.email, nama: data.nama, tugas: data.tugas, role: data.role };
}

async function initLogin() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    if (session && session.user) {
      SESSION = await loadSessionFromAuth(session.user);
      await loadAll();
      enterApp();
    }
  } catch(e){
    console.warn('initLogin gagal (mungkin offline):', e);
  }
}
async function doLogin() {
  const btn = document.getElementById('btnMasuk');
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.style.display = 'none';
  if(!email || !password){
    errEl.textContent = 'Isi email dan password dulu.';
    errEl.style.display = 'block';
    return;
  }
  btn.disabled = true;
  btn.textContent = 'Memeriksa...';
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      errEl.textContent = 'Email atau password salah.';
      errEl.style.display = 'block';
      return;
    }
    SESSION = await loadSessionFromAuth(data.user);
    await loadAll();
    enterApp();
  } catch (e) {
    console.error('Login error:', e);
    errEl.textContent = 'Terjadi kesalahan koneksi: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Masuk';
  }
}
async function logout() {
  await sb.auth.signOut();
  SESSION = null;
  document.getElementById('app').style.display='none';
  document.getElementById('loginScreen').style.display='flex';
}
/* Ukur tinggi topbar sebenarnya lalu simpan ke CSS variable --topbar-h,
   supaya .page-head (judul tab yang stuck) selalu nempel persis di
   bawahnya, di layar berapa pun ukurannya. */
function syncTopbarHeight(){
  const tb = document.querySelector('.topbar');
  if(tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
}
window.addEventListener('resize', syncTopbarHeight);
/* orientationchange kadang tidak diikuti resize tepat waktu di sebagian
   browser HP, jadi disinkron ulang sesaat setelah rotasi selesai supaya
   --topbar-h (dan tinggi page-head yang menempel di bawahnya) selalu akurat. */
window.addEventListener('orientationchange', ()=> setTimeout(syncTopbarHeight, 300));

function enterApp(){
  document.getElementById('loginScreen').style.display='none';
  document.getElementById('app').style.display='block';
  const roleLabel = SESSION.tugas === 'hafalan' ? 'Pembina Hafalan' : (SESSION.tugas === 'absensi' ? 'Pembina Absensi' : 'Pembina');
  document.getElementById('userLabel').textContent = SESSION.nama ? (SESSION.nama + ' \u00b7 ' + roleLabel) : roleLabel;
  const oldBanner = document.getElementById('offlineBanner');
  if(oldBanner) oldBanner.remove();
  if(OFFLINE_MODE){
    const b = document.createElement('div');
    b.id = 'offlineBanner';
    b.style.cssText = 'background:#fdecea;color:#c0392b;padding:8px 14px;font-size:13px;text-align:center';
    b.textContent = '\u26A0 Mode offline: menampilkan cadangan data terakhir. Tambah/ubah data tidak tersedia sampai internet kembali.';
    document.getElementById('app').prepend(b);
  }
  renderNav();
  const nav = navForSession();
  goPage(nav.some(i=>i.id===currentPage) ? currentPage : nav[0].id);
  syncTopbarHeight();
}

/* ---------- NAV ---------- */
function renderNav(){
  const html = navForSession().map(i=>`<button class="navitem" data-p="${i.id}" onclick="goPage('${i.id}')"><span class="ic">${i.icon}</span><span>${i.label}</span></button>`).join('');
  document.getElementById('bottomnav').innerHTML = html;
  document.getElementById('sidebar').innerHTML = html;
}
function goPage(p){
  currentPage = p;
  document.querySelectorAll('.navitem').forEach(el=>el.classList.toggle('active', el.dataset.p===p));
  if(p==='absensi') renderAbsensiPage();
  if(p==='hafalan') renderHafalanPage();
  if(p==='riwayat') renderRiwayatPage();
}

/* santri yang boleh dilihat -- tidak dibatasi program, semua santri tampil */
function visibleSantri(){
  return DB.santri;
}
function visibleSantriForKegiatan(kegiatanId){
  const keg = DB.kegiatan.find(k=>k.id===kegiatanId);
  const base = visibleSantri();
  if(!keg || !keg.programKhusus) return base;
  return base.filter(s=>s.program===keg.programKhusus);
}
function initial(name){ return (name||'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase(); }
function todayStr(){ return new Date().toISOString().slice(0,10); }
function val(id){ return document.getElementById(id).value; }
/* Format tanggal singkat ala Indonesia untuk daftar Riwayat, mis. "12 Agt 2026". */
function fmtTglIndo(t){
  if(!t) return '-';
  const d = new Date(t);
  return d.toLocaleDateString('id-ID', {day:'2-digit', month:'short', year:'numeric'});
}

/* ---------- ABSENSI ---------- */
let absKegiatanId = null, absTanggal = todayStr();
function renderAbsensiPage(){
  if(!absKegiatanId) absKegiatanId = DB.kegiatan[0]?.id;
  const santri = visibleSantriForKegiatan(absKegiatanId);
  const kegAktif = DB.kegiatan.find(k=>k.id===absKegiatanId);
  document.getElementById('content').innerHTML = `
    <div class="page-head">
      <h2>Absensi</h2>
      <div class="card">
        <label>Kegiatan</label>
        <select onchange="absKegiatanId=this.value; renderAbsensiPage()">
          ${DB.kegiatan.map(k=>`<option value="${k.id}" ${k.id===absKegiatanId?'selected':''}>${escapeHtml(k.nama)}${k.programKhusus?' (khusus '+escapeHtml(k.programKhusus)+')':''}</option>`).join('')}
        </select>
        <label>Tanggal</label>
        <input type="date" value="${absTanggal}" onchange="absTanggal=this.value; renderAbsensiPage()">
        ${kegAktif && kegAktif.programKhusus ? `<p class="muted">Hanya menampilkan santri program ${kegAktif.programKhusus}.</p>` : ''}
        <div class="btn-row" style="margin-top:8px">
          <button class="btn btn-accent" onclick="openAbsensiScanner()">&#128247; Scan QR Kartu Santri</button>
        </div>
      </div>
    </div>
    <div class="card">
      ${santri.length===0?'<p class="muted">Belum ada santri yang sesuai untuk kegiatan ini.</p>':santri.map(s=>{
        const rec = DB.absensi.find(a=>a.santriId===s.id && a.kegiatanId===absKegiatanId && a.tanggal===absTanggal);
        const st = rec?rec.status:'';
        return `<div class="att-row">
          <span>${escapeHtml(s.nama)}</span>
          <div class="att-opts">
            <button class="att-btn h ${st==='h'?'on':''}" onclick="setAbsensi('${s.id}','h')">H</button>
            <button class="att-btn a ${st==='a'?'on':''}" onclick="setAbsensi('${s.id}','a')">A</button>
            <button class="att-btn i ${st==='i'?'on':''}" onclick="setAbsensi('${s.id}','i')">I</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <p class="muted">H = Hadir &middot; A = Tidak hadir &middot; I = Izin</p>
  `;
}
async function setAbsensi(santriId, status){
  await sb.from('absensi').delete()
    .eq('santri_id', santriId).eq('kegiatan_id', absKegiatanId).eq('tanggal', absTanggal);
  const { error } = await sb.from('absensi').insert({
    santri_id: santriId, kegiatan_id: absKegiatanId, tanggal: absTanggal, status: STATUS_TO_DB[status], dicatat_oleh: SESSION.nama || SESSION.email
  });
  if(error){ alert('Gagal menyimpan: ' + error.message); return; }
  await loadAll();
  renderAbsensiPage();
}

/* ---------- ABSENSI: SCAN QR KARTU SANTRI ---------- */
let absScanner = null;
let absScanBusy = false;
let absLastScan = { text: '', time: 0 };
let absTorchOn = false;
let absScanFocusTimer = null;

function openAbsensiScanner(){
  if(!absKegiatanId){ alert('Pilih kegiatan terlebih dahulu.'); return; }
  if(typeof Html5Qrcode === 'undefined'){
    alert('Fitur scan QR belum siap dimuat. Pastikan HP terhubung internet lalu coba lagi.');
    return;
  }
  /* Kamera HP (beda dengan webcam laptop yang biasanya dites dari
     localhost) hanya bisa diakses browser lewat halaman yang aman
     (HTTPS), atau lewat "localhost". Kalau app dibuka lewat alamat IP
     polos (http://192.168.x.x, dsb) di HP, browser diam-diam menolak
     izin kamera -- ini penyebab paling sering "jalan di laptop, mati
     di HP". Dicek & dikasih pesan jelas di sini sebelum coba nyalakan
     kamera. */
  const host = location.hostname;
  const isSecure = location.protocol === 'https:' || host === 'localhost' || host === '127.0.0.1';
  if(!isSecure){
    alert('Kamera tidak bisa diakses karena halaman ini dibuka lewat alamat yang tidak aman (' + location.protocol + '//' + host + '). Buka aplikasi ini lewat alamat HTTPS supaya kamera bisa dipakai di HP.');
    return;
  }
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){
    alert('Browser di HP ini tidak mendukung akses kamera lewat web. Coba pakai Chrome/Safari versi terbaru.');
    return;
  }
  absTorchOn = false;
  showModal('Scan Kartu Santri', `
    <p class="muted" id="scanInfo">Arahkan kamera ke QR code di kartu santri.</p>
    <div id="qrReaderAbsensi" class="qr-reader-box"></div>
    <div class="scan-feedback" id="scanFeedback">Menyalakan kamera&hellip;</div>
    <div class="btn-row">
      <button class="btn btn-torch" id="btnTorch" onclick="toggleTorch()" style="display:none">&#128294; Senter</button>
      <button class="btn" onclick="closeAbsensiScanner()">Tutup</button>
    </div>
  `, 'closeAbsensiScanner()');

  absScanner = new Html5Qrcode('qrReaderAbsensi');
  absScanFocusTimer = null;
  absScanner.start(
    /* cameraIdOrConfig -- HARUS persis 1 key, tidak boleh dicampur dengan
       resolusi. Resolusi ditaruh di videoConstraints pada parameter kedua. */
    { facingMode: 'environment' },
    {
      fps: 10,
      qrbox: function(viewfinderWidth, viewfinderHeight){
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const size = Math.max(220, Math.floor(minEdge * 0.75));
        return { width: size, height: size };
      },
      aspectRatio: 1.0,
      disableFlip: false,
      /* Minta resolusi yang cukup tinggi -- resolusi default kamera kadang
         terlalu rendah untuk membaca QR kecil di kartu santri. */
      videoConstraints: {
        facingMode: 'environment',
        width: { ideal: 1280 }, height: { ideal: 720 }
      },
      /* Manfaatkan BarcodeDetector bawaan browser kalau tersedia (Chrome/
         WebView Android) -- jauh lebih cepat & akurat dibanding pembaca
         QR berbasis JS murni, dan sering jadi penyebab kamera cuma
         "berkedip" tanpa pernah berhasil membaca di HP tertentu. */
      experimentalFeatures: { useBarCodeDetectorIfSupported: true }
    },
    onAbsensiScanSuccess,
    function(){ /* frame tanpa QR terbaca, abaikan */ }
  ).then(async ()=>{
    const info = document.getElementById('scanInfo');
    if(info) info.textContent = 'Arahkan kamera ke QR code di kartu santri. Ketuk video kalau gambar buram.';
    const fb = document.getElementById('scanFeedback');
    if(fb){ fb.className = 'scan-feedback'; fb.textContent = 'Siap memindai.'; }
    await applyAbsensiFocus();
    /* Sebagian HP melepas mode fokus kontinu setelah beberapa saat,
       jadi dicoba diterapkan ulang tiap 2 detik supaya kamera tidak
       balik buram. */
    absScanFocusTimer = setInterval(applyAbsensiFocus, 2000);
    try{
      const settings = absScanner.getRunningTrackSettings();
      if(settings && ('torch' in settings)){
        const btn = document.getElementById('btnTorch');
        if(btn) btn.style.display = '';
      }
    }catch(e){}
    /* Tap-to-focus: sentuh area video untuk memaksa kamera fokus ulang,
       berguna kalau perangkat tidak mendukung fokus kontinu otomatis. */
    const box = document.getElementById('qrReaderAbsensi');
    if(box) box.onclick = applyAbsensiFocus;
  }).catch(err=>{
    const info = document.getElementById('scanInfo');
    const fb = document.getElementById('scanFeedback');
    const name = (err && (err.name || err)) + '';
    let pesan;
    if(name.includes('NotAllowedError') || name.includes('PermissionDenied')){
      pesan = 'Izin kamera ditolak. Buka pengaturan situs di browser HP, izinkan Kamera untuk aplikasi ini, lalu coba lagi.';
    } else if(name.includes('NotFoundError') || name.includes('OverconstrainedError')){
      pesan = 'Kamera belakang tidak ditemukan di perangkat ini.';
    } else if(name.includes('NotReadableError')){
      pesan = 'Kamera sedang dipakai aplikasi lain. Tutup aplikasi/tab lain yang memakai kamera lalu coba lagi.';
    } else if(name.includes('SecurityError')){
      pesan = 'Akses kamera diblokir karena halaman tidak dibuka lewat HTTPS.';
    } else {
      pesan = 'Tidak bisa mengakses kamera (' + name + ').';
    }
    if(info) info.textContent = pesan;
    if(fb){ fb.className = 'scan-feedback err'; fb.textContent = pesan; }
  });
}
async function applyAbsensiFocus(){
  if(!absScanner) return;
  try{ await absScanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }); }catch(e){}
}

function onAbsensiScanSuccess(decodedText){
  const now = Date.now();
  if(absScanBusy) return;
  if(decodedText === absLastScan.text && (now - absLastScan.time) < 2500) return;
  absLastScan = { text: decodedText, time: now };
  absScanBusy = true;

  const kode = (decodedText||'').trim();
  const santriList = visibleSantriForKegiatan(absKegiatanId);
  const s = santriList.find(x => x.noInduk === kode);
  const fb = document.getElementById('scanFeedback');

  if(!s){
    if(fb){ fb.className = 'scan-feedback err'; fb.textContent = 'QR tidak dikenali / bukan kartu santri untuk kegiatan ini.'; }
    setTimeout(()=>{ absScanBusy = false; }, 900);
    return;
  }
  markHadirViaScan(s).then(ok=>{
    if(fb){
      fb.className = ok ? 'scan-feedback ok' : 'scan-feedback err';
      fb.textContent = ok ? ('\u2713 Hadir dicatat: ' + s.nama) : ('Gagal menyimpan absen ' + s.nama + ', coba scan ulang.');
    }
    setTimeout(()=>{ absScanBusy = false; }, 900);
  });
}

async function markHadirViaScan(s){
  try{
    await sb.from('absensi').delete()
      .eq('santri_id', s.id).eq('kegiatan_id', absKegiatanId).eq('tanggal', absTanggal);
    const { error } = await sb.from('absensi').insert({
      santri_id: s.id, kegiatan_id: absKegiatanId, tanggal: absTanggal, status: STATUS_TO_DB['h'], dicatat_oleh: SESSION.nama || SESSION.email
    });
    if(error) throw error;
    DB.absensi = DB.absensi.filter(a => !(a.santriId===s.id && a.kegiatanId===absKegiatanId && a.tanggal===absTanggal));
    DB.absensi.push({ santriId: s.id, kegiatanId: absKegiatanId, tanggal: absTanggal, status: 'h' });
    return true;
  } catch(e){
    console.warn('Gagal simpan absensi via scan:', e);
    return false;
  }
}

async function toggleTorch(){
  if(!absScanner) return;
  const next = !absTorchOn;
  try{
    await absScanner.applyVideoConstraints({ advanced: [{ torch: next }] });
    absTorchOn = next;
    const btn = document.getElementById('btnTorch');
    if(btn) btn.classList.toggle('on', absTorchOn);
  } catch(e){
    alert('Senter tidak didukung di perangkat/browser ini.');
  }
}

function closeAbsensiScanner(){
  if(absScanFocusTimer){ clearInterval(absScanFocusTimer); absScanFocusTimer = null; }
  const finish = ()=>{
    absScanner = null;
    absTorchOn = false;
    absScanBusy = false;
    closeModal();
    renderAbsensiPage();
  };
  if(absScanner){
    absScanner.stop().then(()=>{
      try{ absScanner.clear(); }catch(e){}
      finish();
    }).catch(()=> finish());
  } else {
    finish();
  }
}

/* ---------- HAFALAN ---------- */
let hafalanSearchQuery = '';
let hafalanProgramFilter = 'semua'; // 'semua' | 'Takhossus' | 'Non-Takhossus'
function filteredHafalanSantri(){
  const q = hafalanSearchQuery.trim().toLowerCase();
  return visibleSantri().filter(s=>{
    if(hafalanProgramFilter!=='semua' && s.program!==hafalanProgramFilter) return false;
    if(!q) return true;
    return s.nama.toLowerCase().includes(q) || (s.noInduk||'').toLowerCase().includes(q);
  });
}
function renderHafalanPage(){
  document.getElementById('content').innerHTML = `
    <div class="page-head">
      <h2>Hafalan</h2>
      <div class="filter-bar">
        <div class="filter-search">
          <input type="text" id="hafalanSearchInput" placeholder="Cari nama atau no. induk santri..." value="${escapeHtml(hafalanSearchQuery)}" oninput="hafalanSearchQuery=this.value; renderHafalanListBody()">
        </div>
        <select onchange="hafalanProgramFilter=this.value; renderHafalanListBody()">
          <option value="semua" ${hafalanProgramFilter==='semua'?'selected':''}>Semua Program</option>
          <option value="Takhossus" ${hafalanProgramFilter==='Takhossus'?'selected':''}>Takhossus</option>
          <option value="Non-Takhossus" ${hafalanProgramFilter==='Non-Takhossus'?'selected':''}>Non-Takhossus</option>
        </select>
      </div>
    </div>
    <div id="hafalanListBody"></div>
  `;
  renderHafalanListBody();
}
function renderHafalanListBody(){
  const all = visibleSantri();
  const santri = filteredHafalanSantri();
  const body = document.getElementById('hafalanListBody');
  if(!body) return;
  body.innerHTML = `
    ${(hafalanSearchQuery.trim() || hafalanProgramFilter!=='semua') ? `<p class="filter-count">Menampilkan ${santri.length} dari ${all.length} santri</p>` : ''}
    <div class="card">
      ${all.length===0 ? '<p class="muted">Belum ada data santri.</p>' : santri.length===0 ? '<p class="muted">Tidak ada santri yang cocok dengan pencarian/filter.</p>' : santri.map(s=>{
        const t = totalHafalanSantri(s.id);
        return `<div class="list-item">
          <div class="avatar">${escapeHtml(initial(s.nama))}</div>
          <div style="flex:1">
            <div class="name">${escapeHtml(s.nama)}</div>
            <div class="sub">Sedang: ${formatJuzSekarang(s.id)} &middot; <b>Total: ${t.juz} juz ${t.halaman} halaman</b></div>
          </div>
          <button class="btn btn-sm btn-accent" onclick="openHafalanForm('${s.id}')">Input</button>
        </div>`;
      }).join('')}
    </div>
  `;
}
function openHafalanForm(santriId){
  const s = DB.santri.find(x=>x.id===santriId);
  const cur = juzSekarang(santriId);
  const dariDefault = cur.mulai ? 1 : Math.min(20, cur.halaman+1);
  const opts = (n, selected)=>Array.from({length:n},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`).join('');
  const juzOpts = JUZ_ORDER.map(j=>`<option value="${j}" ${j===cur.juz?'selected':''}>${j}</option>`).join('');
  showModal('Input Hafalan - '+s.nama, `
    <label>Tanggal</label><input type="date" id="h_tanggal" value="${todayStr()}">
    <p class="muted" style="margin:0 0 4px">Sedang: ${formatJuzSekarang(santriId)}. Urutan hafalan pondok: 29 &rarr; 30 &rarr; 1 &rarr; 2 &rarr; ... &rarr; 28.</p>
    <label>Juz</label><select id="h_juz">${juzOpts}</select>
    <div class="grid2">
      <div><label>Halaman dari</label><select id="h_halDari" onchange="updateJumlahHalaman()">${opts(20, dariDefault)}</select></div>
      <div><label>Halaman sampai</label><select id="h_halSampai" onchange="updateJumlahHalaman()">${opts(20, dariDefault)}</select></div>
    </div>
    <p class="muted" id="h_jumlahInfo">Jumlah ditambahkan: 1 halaman</p>
    <div class="btn-row"><button class="btn btn-accent" onclick="saveHafalan('${santriId}')">Simpan</button></div>
  `);
}
function updateJumlahHalaman(){
  const dari = parseInt(val('h_halDari'));
  const sampai = parseInt(val('h_halSampai'));
  const info = document.getElementById('h_jumlahInfo');
  if(sampai < dari){
    info.textContent = 'Halaman "sampai" tidak boleh lebih kecil dari "dari"';
    info.style.color = 'var(--danger)';
  } else {
    info.textContent = 'Jumlah ditambahkan: ' + (sampai-dari+1) + ' halaman';
    info.style.color = '';
  }
}
async function saveHafalan(santriId){
  const dari = parseInt(val('h_halDari'));
  const sampai = parseInt(val('h_halSampai'));
  if(sampai < dari){ alert('Halaman "sampai" tidak boleh lebih kecil dari halaman "dari"'); return; }
  const { error } = await sb.from('hafalan').insert({
    santri_id: santriId, tanggal: val('h_tanggal'), juz: parseInt(val('h_juz')),
    halaman_dari: dari, halaman_sampai: sampai, dicatat_oleh: SESSION.nama || SESSION.email
  });
  if(error){ alert('Gagal menyimpan: ' + error.message); return; }
  await loadAll();
  closeModal();
  renderHafalanPage();
}

/* ---------- RIWAYAT (absensi + hafalan, per santri) ---------- */
let riwayatSantriId = null;
let riwayatPeriode = 'bulan';

function periodeRange(periode){
  const now = new Date();
  let from = new Date(now);
  if(periode==='hari'){ /* hari ini saja */ }
  else if(periode==='pekan'){ from.setDate(now.getDate() - 7); }
  else if(periode==='bulan'){ from.setDate(now.getDate() - 30); }
  else if(periode==='tahun'){ from.setFullYear(now.getFullYear() - 1); }
  return { from: from.toISOString().slice(0,10), to: now.toISOString().slice(0,10) };
}
function renderRiwayatPage(){
  const santri = visibleSantri();
  if(!riwayatSantriId || !santri.some(s=>s.id===riwayatSantriId)) riwayatSantriId = santri[0]?.id || null;
  document.getElementById('content').innerHTML = `
    <div class="page-head">
      <h2>Riwayat</h2>
      <div class="card">
        <label>Santri</label>
        <select onchange="riwayatSantriId=this.value; renderRiwayatBody()">
          ${santri.map(s=>`<option value="${s.id}" ${s.id===riwayatSantriId?'selected':''}>${escapeHtml(s.nama)}</option>`).join('')}
        </select>
        <div class="tabs" style="margin-top:10px">
          ${['hari','pekan','bulan','tahun'].map(p=>`<button class="tab ${p===riwayatPeriode?'active':''}" onclick="riwayatPeriode='${p}'; renderRiwayatBody()">${p.charAt(0).toUpperCase()+p.slice(1)}</button>`).join('')}
        </div>
      </div>
    </div>
    <div id="riwayatBody"></div>
  `;
  if(riwayatSantriId) renderRiwayatBody();
  else document.getElementById('riwayatBody').innerHTML = '<p class="muted">Belum ada santri di program ini.</p>';
}
function renderRiwayatBody(){
  if(!riwayatSantriId) return;
  const santriId = riwayatSantriId;
  const { from, to } = periodeRange(riwayatPeriode);
  const hafalan = DB.hafalan.filter(h=>h.santriId===santriId && h.tanggal>=from && h.tanggal<=to).sort((a,b)=>b.tanggal.localeCompare(a.tanggal));
  const absensi = DB.absensi.filter(a=>a.santriId===santriId && a.tanggal>=from && a.tanggal<=to).sort((a,b)=>b.tanggal.localeCompare(a.tanggal));
  const statusLabel = {h:'Hadir', a:'Alpha', i:'Izin'};
  const namaKegiatan = kid => (DB.kegiatan.find(k=>k.id===kid)||{}).nama || '-';
  const totalPeriode = hafalan.reduce((sum,h)=>sum+(h.jumlahHalaman||1),0);
  const hadirPeriode = absensi.filter(a=>a.status==='h').length;
  const t = totalHafalanSantri(santriId);
  const nh = nilaiHafalanSantri(santriId, from, to);
  const na = nilaiAbsensiSantri(santriId, from, to);
  document.getElementById('riwayatBody').innerHTML = `
    <p class="muted">Periode: ${fmtTglIndo(from)} s.d. ${fmtTglIndo(to)}</p>

    <div class="section-heading">Penilaian (periode ini)</div>
    <div class="grid2">
      <div class="highlight-box">
        <div class="hb-label">Nilai Hafalan</div>
        <div class="hb-value">${nh.predikat} &middot; ${predikatLabel(nh.predikat)}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">${nh.tambahan} dari target ${nh.target} halaman (${nh.pct}%)</div>
      </div>
      <div class="highlight-box">
        <div class="hb-label">Nilai Absensi</div>
        <div class="hb-value">${na.predikat} &middot; ${predikatLabel(na.predikat)}</div>
        <div class="muted" style="font-size:12px;margin-top:4px">Hadir ${na.hadir} dari ${na.total} (${na.pct}%)</div>
      </div>
    </div>

    <div class="section-heading">Riwayat Hafalan</div>
    <div class="grid2">
      <div class="highlight-box">
        <div class="hb-label">Total hafalan keseluruhan</div>
        <div class="hb-value">${t.juz} JUZ ${t.halaman} HAL.</div>
      </div>
      <div class="highlight-box">
        <div class="hb-label">Sedang dihafal</div>
        <div class="hb-value" style="font-size:14px">${formatJuzSekarang(santriId).toUpperCase()}</div>
      </div>
    </div>
    <div class="card">
      <div class="card-title">Tren hafalan bertambah (kumulatif periode ini) &middot; +${totalPeriode} halaman</div>
      <canvas id="chartSantriHafalan" width="600" height="180" style="width:100%;height:150px"></canvas>
    </div>
    <div class="card" style="padding:2px 10px">
      ${hafalan.length===0?'<p class="muted" style="padding:10px 4px">Belum ada hafalan dicatat pada periode ini.</p>':
        hafalan.map(h=>{
          const halText = h.halamanDari===h.halamanSampai ? ('Halaman '+h.halamanDari) : ('Halaman '+h.halamanDari+'&ndash;'+h.halamanSampai);
          return `<div class="riwayat-item">
            <span class="riwayat-badge juz">Juz ${h.juz}</span>
            <div class="ri-main">
              <div class="ri-title">${halText}</div>
              <div class="ri-sub">${fmtTglIndo(h.tanggal)}</div>
            </div>
            <div class="ri-right" style="color:var(--green-700)">+${h.jumlahHalaman||1} hal.</div>
          </div>`;
        }).join('')}
    </div>

    <div class="section-heading">Riwayat Absensi (hadir ${hadirPeriode} dari ${absensi.length} tercatat)</div>
    <div class="card">
      <div class="card-title">Persentase kehadiran per kegiatan (periode ini)</div>
      <canvas id="chartSantriAbsensi" width="600" height="180" style="width:100%;height:150px"></canvas>
    </div>
    <div class="card" style="padding:2px 10px">
      ${absensi.length===0?'<p class="muted" style="padding:10px 4px">Belum ada absensi dicatat pada periode ini.</p>':
        absensi.map(a=>{
          const cls = a.status==='h'?'h':(a.status==='i'?'i':'a');
          const label = statusLabel[a.status]||a.status;
          const clr = cls==='h'?'#1f6b3a':(cls==='i'?'#8a5a13':'#c0392b');
          return `<div class="riwayat-item">
            <span class="riwayat-badge ${cls}">${label.charAt(0)}</span>
            <div class="ri-main">
              <div class="ri-title">${escapeHtml(namaKegiatan(a.kegiatanId))}</div>
              <div class="ri-sub">${fmtTglIndo(a.tanggal)}</div>
            </div>
            <div class="ri-right" style="color:${clr}">${label}</div>
          </div>`;
        }).join('')}
    </div>
  `;
  drawSantriHafalanChart(hafalan);
  drawSantriAbsensiChart(santriId, from, to);
}
function drawSantriHafalanChart(hafalanItems){
  const canvas = document.getElementById('chartSantriHafalan');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, pad = 30;
  ctx.clearRect(0,0,W,H);
  const items = hafalanItems.slice().sort((a,b)=>a.tanggal.localeCompare(b.tanggal));
  if(items.length<2){ ctx.fillStyle='#888'; ctx.font='12px sans-serif'; ctx.fillText('Belum cukup data untuk grafik.', 10, H/2); return; }
  let cum = 0;
  const series = items.map(h=>{ cum += (h.jumlahHalaman||1); return { t:h.tanggal, v:cum }; });
  const maxV = Math.max(1, ...series.map(p=>p.v));
  ctx.strokeStyle='#ddd'; ctx.beginPath(); ctx.moveTo(pad,H-pad); ctx.lineTo(W-10,H-pad); ctx.stroke();
  ctx.strokeStyle='#3b5940'; ctx.lineWidth=2; ctx.beginPath();
  series.forEach((p,i)=>{
    const x = pad + (i/(series.length-1||1)) * (W-pad-20);
    const y = H-pad - (p.v/maxV) * (H-pad-20);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke(); ctx.lineWidth=1;
  ctx.fillStyle='#3b5940'; ctx.font='10px sans-serif'; ctx.fillText('Halaman bertambah (kumulatif periode ini)', pad, 14);
}
function drawSantriAbsensiChart(santriId, from, to){
  const canvas = document.getElementById('chartSantriAbsensi');
  if(!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, padL=30, padB=50;
  ctx.clearRect(0,0,W,H);
  const s = DB.santri.find(x=>x.id===santriId);
  const kegiatanList = DB.kegiatan.filter(k=>!k.programKhusus || k.programKhusus===(s&&s.program));
  const rows = kegiatanList.map(k=>{
    const items = DB.absensi.filter(a=>a.santriId===santriId && a.kegiatanId===k.id && a.tanggal>=from && a.tanggal<=to);
    const hadir = items.filter(a=>a.status==='h').length;
    const pct = items.length ? Math.round(hadir/items.length*100) : 0;
    return { k, pct };
  });
  if(rows.length===0){ ctx.fillStyle='#888'; ctx.font='12px sans-serif'; ctx.fillText('Belum ada kegiatan.', 10, H/2); return; }
  const barW = Math.max(14, (W-padL-10) / rows.length - 6);
  ctx.strokeStyle='#ddd'; ctx.beginPath(); ctx.moveTo(padL,H-padB); ctx.lineTo(W-10,H-padB); ctx.stroke();
  rows.forEach((r,i)=>{
    const x = padL + i*(barW+6);
    const h = (r.pct/100) * (H-padB-15);
    ctx.fillStyle = r.pct>=75 ? '#3b5940' : (r.pct>=50 ? '#d19a24' : '#c0392b');
    ctx.fillRect(x, H-padB-h, barW, h);
    ctx.save();
    ctx.translate(x+barW/2, H-padB+4);
    ctx.rotate(Math.PI/4);
    ctx.fillStyle='#555'; ctx.font='9px sans-serif'; ctx.textAlign='left';
    ctx.fillText(r.k.nama, 0, 0);
    ctx.restore();
  });
}

/* ---------- MODAL ---------- */
function showModal(title, bodyHtml, onCloseFnCall){
  const closeCall = onCloseFnCall || 'closeModal()';
  document.getElementById('modalRoot').innerHTML = `
    <div class="modal-overlay" onclick="if(event.target===this) ${closeCall}">
      <div class="modal-box">
        <div class="modal-head"><h3>${title}</h3><button class="modal-close" onclick="${closeCall}">&times;</button></div>
        ${bodyHtml}
      </div>
    </div>
  `;
}
function closeModal(){ document.getElementById('modalRoot').innerHTML=''; }

/* ---------- INIT ---------- */
initLogin();

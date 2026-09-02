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
const STATUS_TO_DB = { h: 'Hadir', a: 'Alpha', i: 'Izin', hd: 'Haid' };
const STATUS_FROM_DB = { Hadir: 'h', Alpha: 'a', Izin: 'i', Sakit: 'a', Haid: 'hd' };

function santriRowToApp(r) {
  return {
    id: r.id, nama: r.nama, noInduk: r.no_induk,
    program: r.program || 'Non-Takhossus',
    hafalanAwal: r.hafalan_awal || 0,
    jenisKelamin: r.jenis_kelamin || ''
  };
}

/* Santri perempuan -- dipakai untuk menampilkan tombol status "Haid" di
   Absensi khusus untuk santri putri. Menerima format 'Perempuan' atau 'P'. */
function isSantriPerempuan(s){
  const jk = (s.jenisKelamin || '').toString().trim().toLowerCase();
  return jk === 'p' || jk.startsWith('perempuan');
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
  /* Status "Haid" dikecualikan total dari perhitungan persentase -- tidak
     dihitung sebagai hadir maupun sebagai alpha/absen, supaya tidak
     menurunkan nilai kehadiran santri putri yang sedang haid. */
  const items = DB.absensi.filter(a=>a.santriId===santriId && a.tanggal>=from && a.tanggal<=to && a.status!=='hd');
  const hadir = items.filter(a=>a.status==='h').length;
  const pct = items.length ? Math.round(hadir/items.length*100) : 0;
  return { hadir, total: items.length, pct, predikat: predikatFromPct(pct) };
}

/* ====== Jenis kegiatan hafalan ======
   Kegiatan hafalan dikenali dari NAMA-nya (harus persis, tanpa memandang huruf besar/kecil)
   yang dibuat lewat Aplikasi Pondok -> Pengaturan -> Kegiatan:
   - 'tambah' (Setoran 1, Setoran Bin Nadhor): menambah hafalan baru, halaman lanjut otomatis, disimpan di tabel `hafalan`.
   - 'ulang' (Murojaah 1, Murojaah 2, Murojaah 3): mengulang hafalan lama (juz + cakupan), disimpan di tabel `murojaah`. */
const HAFALAN_JENIS = {
  'setoran 1': 'tambah',
  'setoran bin nadhor': 'tambah',
  'murojaah 1': 'ulang',
  'murojaah 2': 'ulang',
  'murojaah 3': 'ulang'
};
function jenisKegiatanHafalan(nama){
  return HAFALAN_JENIS[String(nama||'').trim().toLowerCase()] || null;
}
function hafalanKegiatanList(){
  return DB.kegiatan.filter(k=>jenisKegiatanHafalan(k.nama));
}

/* ====== Urutan hafalan pondok ======
   Santri menghafal TIDAK berurutan 1-30, tapi: 29, 30, 1, 2, 3, ... , 28. */
const JUZ_ORDER = [29, 30, ...Array.from({length:28}, (_,i)=>i+1)];
function posisiJuz(juz){ return JUZ_ORDER.indexOf(juz) + 1; }
function juzSetelah(juz){ const p = posisiJuz(juz); return JUZ_ORDER[p % JUZ_ORDER.length]; }
/* Posisi hafalan santri SAAT INI (untuk sesi berikutnya), dihitung dari
   entri `hafalan` (tambah hafalan) TERAKHIR:
   - keterangan "Lancar" (atau kosong/data lama) -> lanjut ke halaman
     berikutnya seperti biasa (atau ke juz berikutnya kalau sudah 20 halaman).
   - keterangan "Ulang" -> sesi berikutnya TIDAK maju, mengulang juz+halaman
     yang sama persis seperti entri terakhir. */
function juzSekarang(santriId){
  const items = DB.hafalan.filter(h=>h.santriId===santriId)
    .slice().sort((a,b)=> a.tanggal===b.tanggal ? String(a.id).localeCompare(String(b.id)) : a.tanggal.localeCompare(b.tanggal));
  if(items.length===0) return { juz: JUZ_ORDER[0], halaman: 0, mulai: true, adaData: false };
  const last = items[items.length-1];
  if(last.keterangan === 'Ulang'){
    return {
      juz: last.juz, halaman: Math.max(0, (last.halamanDari||1) - 1),
      mulai: false, adaData: true, tanggal: last.tanggal,
      perluUlang: true, ulangDari: last.halamanDari, ulangSampai: last.halamanSampai
    };
  }
  if((last.halamanSampai||0) >= 20){
    return { juz: juzSetelah(last.juz), halaman: 0, mulai: true, adaData: true, tanggal: last.tanggal };
  }
  return { juz: last.juz, halaman: last.halamanSampai||0, mulai: false, adaData: true, tanggal: last.tanggal };
}
function formatJuzSekarang(santriId){
  const c = juzSekarang(santriId);
  if(!c.adaData) return `Belum mulai (dimulai dari Juz ${c.juz})`;
  if(c.perluUlang) return `Juz ${c.juz}, halaman ${c.ulangDari}${c.ulangSampai>c.ulangDari?'-'+c.ulangSampai:''} (diulang, belum lancar)`;
  if(c.mulai) return `Juz sebelumnya selesai, giliran Juz ${c.juz} (belum ada input)`;
  return `Juz ${c.juz}, halaman ${c.halaman}`;
}

/* ====== Posisi Muroja'ah SAAT INI (untuk sesi berikutnya) ======
   Sama prinsipnya seperti juzSekarang() di atas, tapi untuk Murojaah 1 /
   Murojaah 2 / Murojaah 3, dan dihitung TERPISAH per kegiatan (masing-masing
   kegiatan punya progres sendiri, karena bisa beda cakupan/jadwal):
   - keterangan "Lancar" -> sesi berikutnya lanjut ke bagian berikutnya
     (kalau sudah bagian terakhir, lanjut ke Juz berikutnya, bagian 1).
   - keterangan "Ulang" -> sesi berikutnya mengulang Juz + cakupan yang sama
     persis seperti entri terakhir. */
function parseCakupanMurojaah(cakupan){
  const s = String(cakupan||'').trim();
  if(s === '1 Juz') return { jumlah: '1', bagian: null };
  const m = s.match(/^(1\/2|1\/4) Juz - Bagian (\d+)$/);
  if(m) return { jumlah: m[1], bagian: parseInt(m[2]) };
  return { jumlah: '1', bagian: null };
}
function murojaahSekarang(santriId, kegiatanId){
  const items = DB.murojaah.filter(m=>m.santriId===santriId && m.kegiatanId===kegiatanId)
    .slice().sort((a,b)=> a.tanggal===b.tanggal ? String(a.id).localeCompare(String(b.id)) : a.tanggal.localeCompare(b.tanggal));
  if(items.length===0){
    const cur = juzSekarang(santriId);
    return { juz: cur.juz, jumlah: '1', bagian: null, mulai: true, adaData: false };
  }
  const last = items[items.length-1];
  const parsed = parseCakupanMurojaah(last.cakupan);
  if(last.keterangan === 'Ulang'){
    return {
      juz: last.juz, jumlah: parsed.jumlah, bagian: parsed.bagian,
      mulai: false, adaData: true, tanggal: last.tanggal, perluUlang: true
    };
  }
  if(parsed.jumlah === '1'){
    return { juz: juzSetelah(last.juz), jumlah: '1', bagian: null, mulai: true, adaData: true, tanggal: last.tanggal };
  }
  const maxBagian = parsed.jumlah === '1/2' ? 2 : 4;
  if(parsed.bagian < maxBagian){
    return { juz: last.juz, jumlah: parsed.jumlah, bagian: parsed.bagian+1, mulai: false, adaData: true, tanggal: last.tanggal };
  }
  return { juz: juzSetelah(last.juz), jumlah: parsed.jumlah, bagian: 1, mulai: true, adaData: true, tanggal: last.tanggal };
}
function formatMurojaahSekarang(santriId, kegiatanId){
  const c = murojaahSekarang(santriId, kegiatanId);
  const cakupanLabel = c.jumlah==='1' ? '1 Juz' : (c.jumlah+' Juz - Bagian '+c.bagian);
  if(!c.adaData) return `Belum ada data (mulai dari Juz ${c.juz})`;
  if(c.perluUlang) return `Juz ${c.juz}, ${cakupanLabel} (diulang, belum lancar)`;
  return `Juz ${c.juz}, ${cakupanLabel}`;
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
let DB = { kegiatan: [], santri: [], absensi: [], hafalan: [], murojaah: [] };
let SESSION = null; // { userId, role, program, nama }

async function loadAll() {
  try {
    const [kegiatanRes, santriRes, absensiRes, hafalanRes, murojaahRes] = await Promise.all([
      sb.from('kegiatan').select('*').eq('aktif', true).order('nama'),
      sb.from('santri_umum').select('*').eq('aktif', true).order('nama'),
      sb.from('absensi').select('*'),
      sb.from('hafalan').select('*'),
      sb.from('murojaah').select('*')
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
        jumlahHalaman: h.halaman_sampai - h.halaman_dari + 1,
        kegiatanId: h.kegiatan_id || null, keterangan: h.keterangan || 'Lancar'
      })),
      murojaah: (murojaahRes && !murojaahRes.error) ? (murojaahRes.data || []).map(m => ({
        id: m.id, santriId: m.santri_id, kegiatanId: m.kegiatan_id, tanggal: m.tanggal,
        juz: m.juz, cakupan: m.cakupan, keterangan: m.keterangan || 'Lancar'
      })) : []
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
}

/* ---------- NAV ---------- */
const NAV_ACTIONS = [
  {id:'refresh', label:'Refresh', icon:'&#8635;', onclick:'refreshApp()'},
  {id:'logout', label:'Keluar', icon:'&#8631;', onclick:'logout()'}
];
function renderNav(){
  const pageBtns = navForSession().map(i=>`<button class="navitem" data-p="${i.id}" onclick="goPage('${i.id}')"><span class="ic">${i.icon}</span><span>${i.label}</span></button>`).join('');
  const actionBtns = NAV_ACTIONS.map(i=>`<button class="navitem navitem-action" id="navaction-${i.id}" onclick="${i.onclick}"><span class="ic">${i.icon}</span><span>${i.label}</span></button>`).join('');
  const html = pageBtns + actionBtns;
  document.getElementById('bottomnav').innerHTML = html;
  document.getElementById('sidebar').innerHTML = html;
}
function goPage(p, opts){
  opts = opts || {};
  /* Tanggal cuma direset ke hari ini kalau ini benar-benar PINDAH tab
     (mis. dari Absensi ke Hafalan), BUKAN setiap kali tombol nav
     ditekan. Sebelumnya, menekan tombol "Hafalan" lagi walau sudah
     berada di tab itu (gampang kesenggol di HP) langsung menimpa balik
     tanggal yang sudah diganti manual (mis. untuk mengisi data
     kemarin) menjadi hari ini lagi. */
  const gantiTab = (currentPage !== p);
  currentPage = p;
  document.querySelectorAll('.navitem').forEach(el=>el.classList.toggle('active', el.dataset.p===p));
  /* Saat pindah tab (bukan cuma saat ganti tanggal manual di dalam tab),
     tanggal direset ke hari ini -- supaya walau kemarin ada yang belum
     diisi, tampilan awal tetap langsung ke hari ini. Tanggalnya tetap
     bisa diganti manual di dalam tab, dan tidak akan tertimpa lagi
     selama masih di tab yang sama. */
  if(p==='absensi'){ if(gantiTab) absTanggal = todayStr(); renderAbsensiPage(); }
  if(p==='hafalan'){ if(gantiTab) hafTanggal = todayStr(); renderHafalanPage(); }
  if(p==='riwayat') renderRiwayatPage();
  /* Catat perpindahan tab ke riwayat browser, supaya tombol Kembali HP bisa
     dipakai untuk pindah ke tab sebelumnya (lihat blok "TOMBOL KEMBALI"
     di bawah), bukan langsung menutup aplikasi. Dilewati kalau perpindahan
     ini sendiri dipicu oleh tombol Kembali (fromPopstate), atau saat
     refresh halaman yang sama (noPush), supaya tidak menumpuk riwayat
     kosong yang percuma. */
  if(!opts.fromPopstate && !opts.noPush) pushAppState({page: p});
}

/* Tombol "Refresh" di tab navigasi: ambil ulang data terbaru dari Supabase
   lalu render ulang halaman yang sedang aktif, tanpa perlu logout/login lagi. */
async function refreshApp(){
  const btns = [document.getElementById('navaction-refresh')].filter(Boolean);
  btns.forEach(b=>{ b.disabled = true; b.classList.add('spinning'); });
  try {
    await loadAll();
    const oldBanner = document.getElementById('offlineBanner');
    if(oldBanner) oldBanner.remove();
    if(OFFLINE_MODE){
      const b = document.createElement('div');
      b.id = 'offlineBanner';
      b.style.cssText = 'background:#fdecea;color:#c0392b;padding:8px 14px;font-size:13px;text-align:center';
      b.textContent = '\u26A0 Mode offline: menampilkan cadangan data terakhir. Tambah/ubah data tidak tersedia sampai internet kembali.';
      document.getElementById('app').prepend(b);
    }
    goPage(currentPage, { noPush: true });
  } catch(e){
    console.error('Gagal refresh data:', e);
    alert('Gagal memuat data terbaru: ' + e.message);
  } finally {
    btns.forEach(b=>{ b.disabled = false; b.classList.remove('spinning'); });
  }
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
/* Format sebuah objek Date menjadi teks tanggal YYYY-MM-DD menurut zona
   waktu Asia/Jakarta (WIB) secara eksplisit -- BUKAN memakai toISOString()
   yang selalu memakai UTC. Ini penting karena UTC tertinggal 7 jam dari
   WIB: kalau dulu pakai toISOString(), setiap jam 00:00-06:59 WIB tanggal
   yang dihasilkan masih tanggal KEMARIN (menurut UTC), padahal untuk
   pembina di Indonesia "hari ini" seharusnya sudah berganti sejak
   tengah malam WIB. Ini yang menyebabkan tanggal default "hari ini"
   sering salah (mundur 1 hari) terutama pas Setoran 1 pagi hari,
   sehingga pembina harus ganti tanggal manual, dan data yang disimpan
   ikut tersimpan di tanggal yang salah (jadi kelihatan seperti "gagal
   tersimpan" padahal sebenarnya tersimpan di tanggal kemarin).
   Dipakai untuk SEMUA perhitungan tanggal "hari ini" di aplikasi ini. */
function toJakartaDateStr(date){
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
  });
  return fmt.format(date); // format en-CA menghasilkan langsung YYYY-MM-DD
}
function todayStr(){ return toJakartaDateStr(new Date()); }
function val(id){ return document.getElementById(id).value; }

/* Kegiatan yang boleh pakai status "Haid": semua kegiatan sholat (nama
   diawali "Sholat" -- Subuh/Dzuhur/Ashar/Maghrib/Isya) dan kegiatan
   "Setoran Bin Nadhor" (membaca mushaf, bukan dari hafalan). Kegiatan
   hafalan/setoran lain (Setoran 1, Murojaah 1, Murojaah 2/3) TIDAK termasuk
   -- santri yang haid tetap wajib setor hafalan seperti biasa. */
function bolehStatusHaid(keg){
  if(!keg) return false;
  const nama = (keg.nama||'').trim().toLowerCase();
  return nama.startsWith('sholat') || nama === 'setoran bin nadhor';
}

/* Cek apakah santri sedang haid PADA TANGGAL yang sedang dipilih di tab
   Hafalan (hafTanggal, default hari ini) -- dilihat dari ada tidaknya
   catatan absensi berstatus "Haid" di tanggal itu, di kegiatan manapun
   (biasanya ditandai lewat salah satu kegiatan Sholat). */
function santriSedangHaidHariIni(santriId){
  const tgl = hafTanggal;
  return DB.absensi.some(a=>a.santriId===santriId && a.tanggal===tgl && a.status==='hd');
}

/* ---------- ABSENSI ---------- */
let absKegiatanId = null, absTanggal = todayStr();
let absFilter = 'semua'; // semua | h | a | i | kosong
let absSearch = '';

function renderAbsensiPage(){
  if(!absKegiatanId) absKegiatanId = DB.kegiatan[0]?.id;
  const kegAktif = DB.kegiatan.find(k=>k.id===absKegiatanId);
  const semuaSantri = visibleSantriForKegiatan(absKegiatanId);
  const kegBolehHaid = bolehStatusHaid(kegAktif);

  /* status tiap santri untuk kegiatan+tanggal terpilih (kosong = belum diisi sama sekali) */
  const withStatus = semuaSantri.map(s=>{
    const rec = DB.absensi.find(a=>a.santriId===s.id && a.kegiatanId===absKegiatanId && a.tanggal===absTanggal);
    return { s, st: rec ? rec.status : '' };
  });
  const jumlah = {
    h: withStatus.filter(x=>x.st==='h').length,
    a: withStatus.filter(x=>x.st==='a').length,
    i: withStatus.filter(x=>x.st==='i').length,
    hd: withStatus.filter(x=>x.st==='hd').length,
    kosong: withStatus.filter(x=>x.st==='').length
  };

  /* terapkan filter status + pencarian nama */
  let tampil = withStatus;
  if(absFilter !== 'semua') tampil = tampil.filter(x => x.st === (absFilter==='kosong' ? '' : absFilter));
  if(absSearch.trim()) {
    const q = absSearch.trim().toLowerCase();
    tampil = tampil.filter(x => x.s.nama.toLowerCase().includes(q));
  }

  const filterTabs = [
    {key:'semua', label:'Semua', count: withStatus.length},
    {key:'kosong', label:'Belum Diisi', count: jumlah.kosong},
    {key:'h', label:'Hadir', count: jumlah.h},
    {key:'i', label:'Izin', count: jumlah.i},
    ...(kegBolehHaid ? [{key:'hd', label:'Haid', count: jumlah.hd}] : []),
    {key:'a', label:'Alpha', count: jumlah.a}
  ];

  document.getElementById('content').innerHTML = `
    <h2>Absensi</h2>
    <div class="card">
      <label>Kegiatan</label>
      <select onchange="absKegiatanId=this.value; absFilter='semua'; absSearch=''; renderAbsensiPage()">
        ${DB.kegiatan.map(k=>`<option value="${k.id}" ${k.id===absKegiatanId?'selected':''}>${escapeHtml(k.nama)}${k.programKhusus?' (khusus '+escapeHtml(k.programKhusus)+')':''}</option>`).join('')}
      </select>
      <label>Tanggal</label>
      <input type="date" value="${absTanggal}" onchange="absTanggal=this.value; renderAbsensiPage()">
      ${kegAktif && kegAktif.programKhusus ? `<p class="muted">Hanya menampilkan santri program ${kegAktif.programKhusus}.</p>` : ''}
      <div class="btn-row" style="margin-top:8px">
        <button class="btn btn-accent" onclick="openAbsensiScanner()">&#128247; Scan QR Kartu Santri</button>
        <button class="btn" onclick="tandaiSisanyaAlpha()">Tandai Sisanya Alpha</button>
      </div>
    </div>
    <div class="card">
      <input type="text" placeholder="Cari nama santri&hellip;" value="${escapeHtml(absSearch)}"
        oninput="absSearch=this.value; renderAbsensiPage()" style="margin-bottom:10px">
      <div class="btn-row" style="margin-top:0">
        ${filterTabs.map(f=>`<button class="btn btn-sm ${absFilter===f.key?'btn-accent':''}" onclick="absFilter='${f.key}'; renderAbsensiPage()">${f.label} (${f.count})</button>`).join('')}
      </div>
    </div>
    <div class="card">
      ${tampil.length===0?'<p class="muted">Tidak ada santri yang cocok dengan filter/pencarian ini.</p>':tampil.map(({s, st})=>{
        return `<div class="att-row">
          <span>${escapeHtml(s.nama)}</span>
          <div class="att-opts">
            <button class="att-btn h ${st==='h'?'on':''}" onclick="setAbsensi('${s.id}','h')">H</button>
            <button class="att-btn i ${st==='i'?'on':''}" onclick="setAbsensi('${s.id}','i')">I</button>
            ${(kegBolehHaid && isSantriPerempuan(s)) ? `<button class="att-btn hd ${st==='hd'?'on':''}" onclick="setAbsensi('${s.id}','hd')" title="Haid">Hd</button>` : ''}
            <button class="att-btn a ${st==='a'?'on':''}" onclick="setAbsensi('${s.id}','a')">A</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    ${kegBolehHaid
      ? '<p class="muted">H = Hadir &middot; I = Izin &middot; Hd = Haid (khusus santri putri, kegiatan sholat &amp; Setoran Bin Nadhor) &middot; A = Tidak hadir/Alpha. Sudah discan QR otomatis H, tap tombol I untuk yang izin/sakit.</p>'
      : '<p class="muted">H = Hadir &middot; I = Izin &middot; A = Tidak hadir/Alpha. Sudah discan QR otomatis H, tap tombol I untuk yang izin/sakit.</p>'}
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

/* Isi otomatis 'Alpha' untuk semua santri yang BELUM ada catatan absensi
   (belum discan & belum ditandai manual) pada kegiatan+tanggal terpilih.
   Santri yang sudah H atau I tidak diubah. Setelah ini pembina tinggal
   pakai filter "Alpha" lalu tap tombol I untuk yang ternyata izin/sakit. */
async function tandaiSisanyaAlpha(){
  const semuaSantri = visibleSantriForKegiatan(absKegiatanId);
  const belumDiisi = semuaSantri.filter(s => !DB.absensi.find(a=>a.santriId===s.id && a.kegiatanId===absKegiatanId && a.tanggal===absTanggal));
  if(belumDiisi.length===0){ alert('Semua santri sudah memiliki catatan absensi untuk kegiatan & tanggal ini.'); return; }
  if(!confirm(`Tandai ${belumDiisi.length} santri yang belum diisi sebagai Alpha?`)) return;
  const rows = belumDiisi.map(s => ({
    santri_id: s.id, kegiatan_id: absKegiatanId, tanggal: absTanggal, status: STATUS_TO_DB['a'], dicatat_oleh: SESSION.nama || SESSION.email
  }));
  const { error } = await sb.from('absensi').insert(rows);
  if(error){ alert('Gagal menyimpan: ' + error.message); return; }
  await loadAll();
  absFilter = 'a';
  renderAbsensiPage();
}

/* ---------- ABSENSI: SCAN QR KARTU SANTRI ---------- */
let absScanner = null;
let absScanBusy = false;
let absLastScan = { text: '', time: 0 };
let absTorchOn = false;

function openAbsensiScanner(){
  if(!absKegiatanId){ alert('Pilih kegiatan terlebih dahulu.'); return; }
  if(typeof Html5Qrcode === 'undefined'){
    alert('Fitur scan QR belum siap dimuat. Pastikan HP terhubung internet lalu coba lagi.');
    return;
  }
  absTorchOn = false;
  /* Buka/resume AudioContext di sini (dipicu tap tombol) supaya browser
     mobile mengizinkan bunyi diputar nanti saat scan sukses. */
  try{
    if(!_absAudioCtx) _absAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(_absAudioCtx.state === 'suspended') _absAudioCtx.resume();
  }catch(e){}
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
  absScanner.start(
    { facingMode: 'environment' },
    {
      fps: 10,
      qrbox: function(viewfinderWidth, viewfinderHeight){
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const size = Math.max(150, Math.floor(minEdge * 0.7));
        return { width: size, height: size };
      }
    },
    onAbsensiScanSuccess,
    function(){ /* frame tanpa QR terbaca, abaikan */ }
  ).then(async ()=>{
    const info = document.getElementById('scanInfo');
    if(info) info.textContent = 'Arahkan kamera ke QR code di kartu santri.';
    const fb = document.getElementById('scanFeedback');
    if(fb){ fb.className = 'scan-feedback'; fb.textContent = 'Siap memindai.'; }
    try{ await absScanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }); }catch(e){}
    try{
      const settings = absScanner.getRunningTrackSettings();
      if(settings && ('torch' in settings)){
        const btn = document.getElementById('btnTorch');
        if(btn) btn.style.display = '';
      }
    }catch(e){}
  }).catch(err=>{
    const info = document.getElementById('scanInfo');
    if(info) info.textContent = 'Tidak bisa mengakses kamera: ' + err;
  });
}

/* Getar + bunyi saat scan berhasil dicatat. Pakai Web Audio API (bukan file
   audio) supaya tetap jalan offline sebagai PWA, dan navigator.vibrate untuk
   getar (hanya didukung di beberapa browser Android; di iOS akan diabaikan
   otomatis tanpa error). */
let _absAudioCtx = null;
function playScanSuccessFeedback(){
  try{
    if(navigator.vibrate) navigator.vibrate(150);
  }catch(e){}
  try{
    if(!_absAudioCtx) _absAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _absAudioCtx;
    if(ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.23);
  }catch(e){}
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
    if(ok) playScanSuccessFeedback();
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
let hafSearchQuery = '';
let hafProgramFilter = '';
let hafKegiatanId = null;
let hafTanggal = todayStr(); // default hari ini, tapi bisa diganti manual seperti di tab Absensi

/* Daftar santri Hafalan setelah difilter oleh pencarian nama/no. induk dan
   dropdown program. Pencarian manual ini tetap ada berdampingan dengan
   scanner QR sebagai antisipasi kalau scan gagal/error. */
function filteredHafalanSantri(){
  const q = (hafSearchQuery||'').trim().toLowerCase();
  return visibleSantriForKegiatan(hafKegiatanId).filter(s=>{
    if(hafProgramFilter && s.program !== hafProgramFilter) return false;
    if(!q) return true;
    return (s.nama||'').toLowerCase().includes(q) || (s.noInduk||'').toLowerCase().includes(q);
  });
}

/* Cek apakah santri sudah diinput hafalan/murojaah pada TANGGAL yang
   sedang dipilih (hafTanggal, default hari ini) untuk kegiatan yang sedang
   dipilih -- dipakai untuk menandai tombol Input jadi merah dan untuk
   menggeser santri yang sudah diinput ke bawah daftar. */
function sudahInputHafalanHariIni(santriId, kegiatanId){
  if(!kegiatanId) return false;
  const tgl = hafTanggal;
  return DB.hafalan.some(h=>h.santriId===santriId && h.kegiatanId===kegiatanId && h.tanggal===tgl)
      || DB.murojaah.some(m=>m.santriId===santriId && m.kegiatanId===kegiatanId && m.tanggal===tgl);
}

/* Kalau kegiatan+tanggal+santri belum ada catatan absensi sama sekali,
   tandai otomatis Hadir begitu hafalan/murojaah-nya diinput -- supaya
   pembina tidak perlu isi absensi Setoran/Murojaah secara terpisah.
   Kalau sudah ada catatan (mis. Izin), tidak diubah. */
async function tandaiHadirOtomatis(santriId, kegiatanId, tanggal){
  if(!kegiatanId) return;
  const ada = DB.absensi.find(a=>a.santriId===santriId && a.kegiatanId===kegiatanId && a.tanggal===tanggal);
  if(ada) return;
  try{
    await sb.from('absensi').insert({
      santri_id: santriId, kegiatan_id: kegiatanId, tanggal, status: STATUS_TO_DB['h'],
      dicatat_oleh: SESSION.nama || SESSION.email
    });
  }catch(e){ console.warn('Gagal menandai hadir otomatis:', e); }
}

function renderHafalanPage(){
  /* Simpan fokus & posisi kursor input pencarian, supaya tidak hilang saat
     seluruh #content di-render ulang setiap kali user mengetik. */
  const activeEl = document.activeElement;
  const activeId = activeEl && activeEl.id;
  const selStart = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
  const selEnd = activeEl && typeof activeEl.selectionEnd === 'number' ? activeEl.selectionEnd : null;

  const listKeg = hafalanKegiatanList();
  if(!hafKegiatanId || !listKeg.some(k=>k.id===hafKegiatanId)) hafKegiatanId = listKeg[0]?.id || null;

  if(!hafKegiatanId){
    document.getElementById('content').innerHTML = `
      <h2>Hafalan</h2>
      <div class="card">
        <p class="muted">Belum ada kegiatan hafalan yang dikonfigurasi. Minta Admin Pusat menambahkan 5 kegiatan berikut lewat Aplikasi Pondok &rarr; Pengaturan &rarr; Kegiatan (ketik nama persis seperti ini):</p>
        <ul class="muted">
          <li>Setoran 1</li>
          <li>Murojaah 1</li>
          <li>Murojaah 2</li>
          <li>Murojaah 3</li>
          <li>Setoran Bin Nadhor</li>
        </ul>
      </div>
    `;
    return;
  }

  const kegAktif = listKeg.find(k=>k.id===hafKegiatanId);
  const jenis = jenisKegiatanHafalan(kegAktif.nama); // 'tambah' | 'ulang'
  const isSetoran1 = kegAktif.nama.trim().toLowerCase() === 'setoran 1';
  const isHariIni = hafTanggal === todayStr();
  const programs = ['Takhossus', 'Non-Takhossus'];
  /* Santri yang sudah diinput pada tanggal terpilih untuk kegiatan aktif
     digeser ke bawah daftar (urutan sisanya tetap seperti semula -- sort stabil). */
  const santri = filteredHafalanSantri()
    .map(s=>({ s, sudah: sudahInputHafalanHariIni(s.id, hafKegiatanId), haid: isSetoran1 && santriSedangHaidHariIni(s.id) }))
    .sort((a,b)=> (a.sudah===b.sudah) ? 0 : (a.sudah ? 1 : -1));

  document.getElementById('content').innerHTML = `
    <h2>Hafalan</h2>
    <div class="card">
      <label>Kegiatan</label>
      <select onchange="hafKegiatanId=this.value; renderHafalanPage()">
        ${listKeg.map(k=>`<option value="${k.id}" ${k.id===hafKegiatanId?'selected':''}>${escapeHtml(k.nama)}</option>`).join('')}
      </select>
      <label>Tanggal</label>
      <input type="date" value="${hafTanggal}" onchange="hafTanggal=this.value; renderHafalanPage()">
      <p class="muted" style="margin:6px 0 0">${isSetoran1 ? 'Bisa pilih Tambah Hafalan Baru atau Mengulang Hafalan (Muroja&rsquo;ah) saat Input.' : (jenis==='tambah' ? 'Menambah hafalan baru &mdash; halaman lanjut otomatis dari posisi terakhir.' : 'Mengulang hafalan yang sudah dihafal (bukan menambah hafalan baru).')}</p>
      ${kegAktif.programKhusus ? `<p class="muted">Hanya menampilkan santri program ${escapeHtml(kegAktif.programKhusus)}.</p>` : ''}
    </div>
    <div class="hafalan-toolbar">
      <div class="search-box">
        <span class="search-ic">&#128269;</span>
        <input type="text" id="hafSearchInput" placeholder="Cari nama atau no. induk santri..."
          value="${escapeHtml(hafSearchQuery)}"
          oninput="hafSearchQuery=this.value; renderHafalanPage()">
      </div>
      <select onchange="hafProgramFilter=this.value; renderHafalanPage()">
        <option value="" ${hafProgramFilter===''?'selected':''}>Semua Program</option>
        ${programs.map(p=>`<option value="${escapeHtml(p)}" ${p===hafProgramFilter?'selected':''}>${escapeHtml(p)}</option>`).join('')}
      </select>
      <button class="icon-btn-square" onclick="openHafalanScanner()" title="Scan QR Kartu Santri" aria-label="Scan QR Kartu Santri">&#128247;</button>
    </div>
    <div class="card">
      ${santri.length===0?'<p class="muted">Tidak ada santri yang cocok.</p>':santri.map(({s, sudah, haid})=>{
        const t = totalHafalanSantri(s.id);
        let sub = jenis==='tambah'
          ? `Sedang: ${formatJuzSekarang(s.id)} &middot; <b>Total: ${t.juz} juz ${t.halaman} halaman</b>`
          : `Total hafalan berjalan: <b>${t.juz} juz ${t.halaman} halaman</b>`;
        if(haid) sub += ' <span class="badge-haid">&#9679; Haid &mdash; disarankan Muroja\'ah 1/4 juz</span>';
        if(sudah) sub += ` <span class="badge-done">&#10003; Sudah diinput ${isHariIni ? 'hari ini' : 'pada tanggal ini'}</span>`;
        return `<div class="list-item">
          <div class="avatar">${escapeHtml(initial(s.nama))}</div>
          <div style="flex:1">
            <div class="name">${escapeHtml(s.nama)}</div>
            <div class="sub">${sub}</div>
          </div>
          <button class="btn btn-sm ${sudah?'btn-danger-solid':'btn-accent'}" onclick="openHafalanInputForm('${s.id}')">Input</button>
        </div>`;
      }).join('')}
    </div>
  `;

  if(activeId === 'hafSearchInput'){
    const el = document.getElementById('hafSearchInput');
    if(el){
      el.focus();
      if(selStart !== null){ try{ el.setSelectionRange(selStart, selEnd); }catch(e){} }
    }
  }
}

/* Dipanggil dari tombol Input maupun dari hasil scan QR -- membuka form yang
   sesuai dengan kegiatan hafalan yang sedang dipilih di dropdown Kegiatan.
   Khusus kegiatan "Setoran 1": pembina memilih dulu Tambah Hafalan Baru atau
   Mengulang Hafalan (format 1/1/2/1/4 Juz seperti Murojaah). */
function openHafalanInputForm(santriId){
  const keg = DB.kegiatan.find(k=>k.id===hafKegiatanId);
  const jenis = jenisKegiatanHafalan(keg && keg.nama);
  const namaKeg = (keg && keg.nama || '').trim().toLowerCase();
  if(namaKeg === 'setoran 1'){
    openSetoran1PilihanForm(santriId, hafKegiatanId);
    return;
  }
  if(jenis === 'ulang') openMurojaahForm(santriId, hafKegiatanId);
  else openHafalanForm(santriId, hafKegiatanId);
}

/* Layar pilihan khusus Setoran 1 -- tambah hafalan baru atau mengulang
   (muroja'ah). Kalau santri sedang haid, disarankan Mengulang dan langsung
   di-preset 1/4 Juz begitu tombol itu dipilih. */
function openSetoran1PilihanForm(santriId, kegiatanId){
  const s = DB.santri.find(x=>x.id===santriId);
  const haid = santriSedangHaidHariIni(santriId);
  showModal("Setoran 1 - "+s.nama, `
    ${haid ? '<p class="muted" style="margin:0 0 10px;color:var(--danger)">Santri sedang Haid &mdash; disarankan pilih Mengulang Hafalan.</p>' : ''}
    <p class="muted" style="margin:0 0 10px">Pilih jenis setoran hari ini:</p>
    <div class="btn-row" style="flex-direction:column">
      <button class="btn btn-accent" style="width:100%" onclick="openHafalanForm('${santriId}','${kegiatanId}')">&#10133; Tambah Hafalan Baru</button>
      <button class="btn" style="width:100%" onclick="openMurojaahUlangDariSetoran1('${santriId}','${kegiatanId}', ${haid ? 'true' : 'false'})">&#128257; Mengulang Hafalan (Muroja&rsquo;ah)</button>
    </div>
  `);
}
/* Pembantu supaya atribut onclick di atas tidak perlu quote object literal
   secara langsung (menghindari konflik tanda kutip ganda). */
function openMurojaahUlangDariSetoran1(santriId, kegiatanId, haid){
  if(haid) openMurojaahForm(santriId, kegiatanId, { presetJumlah: '1/4', catatanHaid: true });
  else openMurojaahForm(santriId, kegiatanId, { judul: "Muroja'ah (Setoran 1)" });
}

/* ---- Form Tipe A: Setoran 1 / Setoran Bin Nadhor (menambah hafalan baru) ----
   Keterangan "Lancar/Ulang" menentukan posisi mulai sesi BERIKUTNYA: Lancar
   -> lanjut ke halaman berikutnya seperti biasa; Ulang -> sesi berikutnya
   mengulang halaman yang sama (lihat juzSekarang()). */
function openHafalanForm(santriId, kegiatanId){
  const s = DB.santri.find(x=>x.id===santriId);
  const keg = DB.kegiatan.find(k=>k.id===kegiatanId);
  const cur = juzSekarang(santriId);
  const dariDefault = cur.mulai ? 1 : Math.min(20, cur.halaman+1);
  const opts = (n, selected)=>Array.from({length:n},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===selected?'selected':''}>${v}</option>`).join('');
  const juzOpts = JUZ_ORDER.map(j=>`<option value="${j}" ${j===cur.juz?'selected':''}>${j}</option>`).join('');
  showModal('Input '+(keg?keg.nama:'Hafalan')+' - '+s.nama, `
    <label>Tanggal</label><input type="date" id="h_tanggal" value="${hafTanggal}">
    <p class="muted" style="margin:0 0 4px">Sedang: ${formatJuzSekarang(santriId)}. Urutan hafalan pondok: 29 &rarr; 30 &rarr; 1 &rarr; 2 &rarr; ... &rarr; 28.</p>
    <label>Juz</label><select id="h_juz">${juzOpts}</select>
    <div class="grid2">
      <div><label>Halaman dari</label><select id="h_halDari" onchange="updateJumlahHalaman()">${opts(20, dariDefault)}</select></div>
      <div><label>Halaman sampai</label><select id="h_halSampai" onchange="updateJumlahHalaman()">${opts(20, dariDefault)}</select></div>
    </div>
    <p class="muted" id="h_jumlahInfo">Jumlah ditambahkan: 1 halaman</p>
    <label>Keterangan</label>
    <select id="h_keterangan">
      <option value="Lancar" selected>Lancar &mdash; besok lanjut ke halaman berikutnya</option>
      <option value="Ulang">Ulang &mdash; besok mengulang halaman yang sama</option>
    </select>
    <div class="btn-row"><button class="btn btn-accent" onclick="saveHafalan('${santriId}','${kegiatanId}')">Simpan</button></div>
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
async function saveHafalan(santriId, kegiatanId){
  const dari = parseInt(val('h_halDari'));
  const sampai = parseInt(val('h_halSampai'));
  if(sampai < dari){ alert('Halaman "sampai" tidak boleh lebih kecil dari halaman "dari"'); return; }
  const tanggal = val('h_tanggal');
  const { error } = await sb.from('hafalan').insert({
    santri_id: santriId, tanggal, juz: parseInt(val('h_juz')),
    halaman_dari: dari, halaman_sampai: sampai, kegiatan_id: kegiatanId || null,
    keterangan: val('h_keterangan'), dicatat_oleh: SESSION.nama || SESSION.email
  });
  if(error){ alert('Gagal menyimpan: ' + error.message); return; }
  await tandaiHadirOtomatis(santriId, kegiatanId, tanggal);
  await loadAll();
  closeModal();
  renderHafalanPage();
}

/* ---- Form Tipe B: Murojaah 1 / Murojaah 2 / Murojaah 3 (mengulang hafalan lama) ----
   opts.presetJumlah & opts.catatanHaid dipakai saat form ini dibuka sebagai
   pengganti Setoran 1 untuk santri yang sedang haid (lihat openHafalanInputForm). */
function openMurojaahForm(santriId, kegiatanId, opts){
  opts = opts || {};
  const s = DB.santri.find(x=>x.id===santriId);
  const keg = DB.kegiatan.find(k=>k.id===kegiatanId);
  const cur = murojaahSekarang(santriId, kegiatanId);
  const defJumlah = opts.presetJumlah || cur.jumlah;
  const defBagian = opts.presetJumlah ? null : cur.bagian;
  const juzOpts = JUZ_ORDER.map(j=>`<option value="${j}" ${j===cur.juz?'selected':''}>Juz ${j}</option>`).join('');
  const jumlahOpts = ['1', '1/2', '1/4'].map(v=>`<option value="${v}" ${v===defJumlah?'selected':''}>${v==='1'?'1 Juz':v+' Juz'}</option>`).join('');
  const judul = opts.judul || (opts.catatanHaid ? "Muroja'ah (pengganti Setoran 1)" : (keg?keg.nama:'Murojaah'));
  showModal('Input '+judul+' - '+s.nama, `
    ${opts.catatanHaid ? '<p class="muted" style="margin:0 0 8px;color:var(--danger)">Santri sedang Haid &mdash; Setoran 1 diganti muroja\'ah, bukan menambah hafalan baru.</p>' : ''}
    <label>Tanggal</label><input type="date" id="m_tanggal" value="${hafTanggal}">
    ${opts.presetJumlah ? '' : `<p class="muted" style="margin:0 0 4px">Sedang: ${escapeHtml(formatMurojaahSekarang(santriId, kegiatanId))}</p>`}
    <label>Juz</label><select id="m_juz">${juzOpts}</select>
    <label>Jumlah</label>
    <select id="m_jumlah" onchange="updateMurojaahBagian()">${jumlahOpts}</select>
    <div id="m_bagianWrap" style="display:none">
      <label>Bagian</label>
      <select id="m_bagian"></select>
    </div>
    <label>Keterangan</label>
    <select id="m_keterangan">
      <option value="Lancar" selected>Lancar &mdash; besok lanjut ke bagian berikutnya</option>
      <option value="Ulang">Ulang &mdash; besok mengulang Juz/bagian yang sama</option>
    </select>
    <div class="btn-row"><button class="btn btn-accent" onclick="saveMurojaah('${santriId}','${kegiatanId}')">Simpan</button></div>
  `);
  updateMurojaahBagian(defBagian);
}
function updateMurojaahBagian(defBagian){
  const jumlah = val('m_jumlah');
  const wrap = document.getElementById('m_bagianWrap');
  const sel = document.getElementById('m_bagian');
  if(jumlah === '1'){ wrap.style.display = 'none'; sel.innerHTML = ''; return; }
  wrap.style.display = '';
  const n = jumlah === '1/2' ? 2 : 4;
  sel.innerHTML = Array.from({length:n},(_,i)=>i+1).map(v=>`<option value="${v}" ${v===defBagian?'selected':''}>Bagian ${v}</option>`).join('');
}
async function saveMurojaah(santriId, kegiatanId){
  const jumlah = val('m_jumlah');
  const juz = parseInt(val('m_juz'));
  const tanggal = val('m_tanggal');
  let cakupan;
  if(jumlah === '1'){
    cakupan = '1 Juz';
  } else {
    const bagian = val('m_bagian');
    if(!bagian){ alert('Pilih bagian terlebih dahulu.'); return; }
    cakupan = (jumlah === '1/2' ? '1/2 Juz' : '1/4 Juz') + ' - Bagian ' + bagian;
  }
  const { error } = await sb.from('murojaah').insert({
    santri_id: santriId, kegiatan_id: kegiatanId, tanggal, juz, cakupan,
    keterangan: val('m_keterangan'), dicatat_oleh: SESSION.nama || SESSION.email
  });
  if(error){ alert('Gagal menyimpan: ' + error.message); return; }
  await tandaiHadirOtomatis(santriId, kegiatanId, tanggal);
  await loadAll();
  closeModal();
  renderHafalanPage();
}

/* ---------- HAFALAN: SCAN QR KARTU SANTRI ---------- */
let hafScanner = null;
let hafTorchOn = false;
let hafScanBusy = false;
let hafLastScan = { text: '', time: 0 };

function openHafalanScanner(){
  if(typeof Html5Qrcode === 'undefined'){
    alert('Fitur scan QR belum siap dimuat. Pastikan HP terhubung internet lalu coba lagi.');
    return;
  }
  hafTorchOn = false;
  /* Buka/resume AudioContext di sini (dipicu tap tombol) supaya browser
     mobile mengizinkan bunyi diputar nanti saat scan sukses. */
  try{
    if(!_absAudioCtx) _absAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if(_absAudioCtx.state === 'suspended') _absAudioCtx.resume();
  }catch(e){}
  showModal('Scan Kartu Santri', `
    <p class="muted" id="hafScanInfo">Arahkan kamera ke QR code di kartu santri.</p>
    <div id="qrReaderHafalan" class="qr-reader-box"></div>
    <div class="scan-feedback" id="hafScanFeedback">Menyalakan kamera&hellip;</div>
    <div class="btn-row">
      <button class="btn btn-torch" id="btnTorchHafalan" onclick="toggleTorchHafalan()" style="display:none">&#128294; Senter</button>
      <button class="btn" onclick="closeHafalanScanner()">Tutup</button>
    </div>
  `, 'closeHafalanScanner()');

  hafScanner = new Html5Qrcode('qrReaderHafalan');
  hafScanner.start(
    { facingMode: 'environment' },
    {
      fps: 10,
      qrbox: function(viewfinderWidth, viewfinderHeight){
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const size = Math.max(150, Math.floor(minEdge * 0.7));
        return { width: size, height: size };
      }
    },
    onHafalanScanSuccess,
    function(){ /* frame tanpa QR terbaca, abaikan */ }
  ).then(async ()=>{
    const info = document.getElementById('hafScanInfo');
    if(info) info.textContent = 'Arahkan kamera ke QR code di kartu santri.';
    const fb = document.getElementById('hafScanFeedback');
    if(fb){ fb.className = 'scan-feedback'; fb.textContent = 'Siap memindai.'; }
    /* Auto fokus: minta kamera fokus terus-menerus (continuous autofocus)
       supaya QR di kartu tetap tajam tanpa perlu tap manual. */
    try{ await hafScanner.applyVideoConstraints({ advanced: [{ focusMode: 'continuous' }] }); }catch(e){}
    try{
      const settings = hafScanner.getRunningTrackSettings();
      if(settings && ('torch' in settings)){
        const btn = document.getElementById('btnTorchHafalan');
        if(btn) btn.style.display = '';
      }
    }catch(e){}
  }).catch(err=>{
    const info = document.getElementById('hafScanInfo');
    if(info) info.textContent = 'Tidak bisa mengakses kamera: ' + err;
  });
}

function onHafalanScanSuccess(decodedText){
  const now = Date.now();
  if(hafScanBusy) return;
  if(decodedText === hafLastScan.text && (now - hafLastScan.time) < 2500) return;
  hafLastScan = { text: decodedText, time: now };
  hafScanBusy = true;

  const kode = (decodedText||'').trim();
  const santriList = visibleSantri();
  const s = santriList.find(x => x.noInduk === kode);
  const fb = document.getElementById('hafScanFeedback');

  if(!s){
    if(fb){ fb.className = 'scan-feedback err'; fb.textContent = 'QR tidak dikenali / bukan kartu santri untuk program ini.'; }
    setTimeout(()=>{ hafScanBusy = false; }, 900);
    return;
  }

  if(fb){ fb.className = 'scan-feedback ok'; fb.textContent = '\u2713 Terdeteksi: ' + s.nama; }
  playScanSuccessFeedback();
  /* Langsung buka form Input Hafalan untuk santri yang terdeteksi -- tapi
     TUNGGU sampai kamera benar-benar berhenti dulu (closeHafalanScanner
     bersifat async), supaya modal form tidak ikut tertutup belakangan. */
  setTimeout(()=>{
    closeHafalanScanner(()=> openHafalanInputForm(s.id));
  }, 500);
}

async function toggleTorchHafalan(){
  if(!hafScanner) return;
  const next = !hafTorchOn;
  try{
    await hafScanner.applyVideoConstraints({ advanced: [{ torch: next }] });
    hafTorchOn = next;
    const btn = document.getElementById('btnTorchHafalan');
    if(btn) btn.classList.toggle('on', hafTorchOn);
  } catch(e){
    alert('Senter tidak didukung di perangkat/browser ini.');
  }
}

function closeHafalanScanner(afterClose){
  const finish = ()=>{
    hafScanner = null;
    hafTorchOn = false;
    hafScanBusy = false;
    if(typeof afterClose === 'function') afterClose();
    else closeModal();
  };
  if(hafScanner){
    hafScanner.stop().then(()=>{
      try{ hafScanner.clear(); }catch(e){}
      finish();
    }).catch(()=> finish());
  } else {
    finish();
  }
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
  return { from: toJakartaDateStr(from), to: toJakartaDateStr(now) };
}
function renderRiwayatPage(){
  const santri = visibleSantri();
  if(!riwayatSantriId || !santri.some(s=>s.id===riwayatSantriId)) riwayatSantriId = santri[0]?.id || null;
  document.getElementById('content').innerHTML = `
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
  const murojaah = DB.murojaah.filter(m=>m.santriId===santriId && m.tanggal>=from && m.tanggal<=to).sort((a,b)=>b.tanggal.localeCompare(a.tanggal));
  const absensi = DB.absensi.filter(a=>a.santriId===santriId && a.tanggal>=from && a.tanggal<=to).sort((a,b)=>b.tanggal.localeCompare(a.tanggal));
  const statusLabel = {h:'Hadir', a:'Alpha', i:'Izin'};
  const namaKegiatan = kid => (DB.kegiatan.find(k=>k.id===kid)||{}).nama || '-';
  const totalPeriode = hafalan.reduce((sum,h)=>sum+(h.jumlahHalaman||1),0);
  const t = totalHafalanSantri(santriId);
  const nh = nilaiHafalanSantri(santriId, from, to);
  const na = nilaiAbsensiSantri(santriId, from, to);
  document.getElementById('riwayatBody').innerHTML = `
    <p class="muted">Periode: ${from} s.d. ${to}</p>

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

    <div class="section-heading">Riwayat Hafalan (ditambahkan pada periode ini: ${totalPeriode} halaman)</div>
    <div class="highlight-box">
      <div class="hb-label">Total hafalan keseluruhan</div>
      <div class="hb-value">${t.juz} JUZ ${t.halaman} HALAMAN</div>
    </div>
    <div class="highlight-box">
      <div class="hb-label">Sedang dihafal</div>
      <div class="hb-value">${formatJuzSekarang(santriId).toUpperCase()}</div>
    </div>
    <canvas id="chartSantriHafalan" width="600" height="180" style="width:100%;height:150px;margin-top:8px"></canvas>
    ${hafalan.length===0?'<p class="muted">Belum ada hafalan dicatat pada periode ini.</p>':`
      <table><tr><th>Tanggal</th><th>Kegiatan</th><th>Juz</th><th>Halaman</th><th>Ket.</th></tr>
      ${hafalan.map(h=>`<tr><td>${h.tanggal}</td><td>${escapeHtml(namaKegiatan(h.kegiatanId))}</td><td>${h.juz}</td><td>${h.halamanDari===h.halamanSampai?h.halamanDari:h.halamanDari+'-'+h.halamanSampai}</td><td>${h.keterangan==='Ulang'?'<span style="color:var(--danger)">Ulang</span>':'Lancar'}</td></tr>`).join('')}
      </table>`}

    <div class="section-heading">Riwayat Murojaah (periode ini)</div>
    ${murojaah.length===0?'<p class="muted">Belum ada dicatat pada periode ini.</p>':`
      <table><tr><th>Tanggal</th><th>Kegiatan</th><th>Juz</th><th>Cakupan</th><th>Ket.</th></tr>
      ${murojaah.map(m=>`<tr><td>${m.tanggal}</td><td>${escapeHtml(namaKegiatan(m.kegiatanId))}</td><td>${m.juz}</td><td>${escapeHtml(m.cakupan)}</td><td>${m.keterangan==='Ulang'?'<span style="color:var(--danger)">Ulang</span>':'Lancar'}</td></tr>`).join('')}
      </table>`}

    <div class="section-heading">Riwayat Absensi (periode ini)</div>
    <canvas id="chartSantriAbsensi" width="600" height="180" style="width:100%;height:150px"></canvas>
    ${absensi.length===0?'<p class="muted">Belum ada absensi dicatat pada periode ini.</p>':`
      <table><tr><th>Tanggal</th><th>Kegiatan</th><th>Status</th></tr>
      ${absensi.map(a=>`<tr><td>${a.tanggal}</td><td>${namaKegiatan(a.kegiatanId)}</td><td>${statusLabel[a.status]||a.status}</td></tr>`).join('')}
      </table>`}
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
    /* Status "Haid" dikecualikan dari perhitungan persentase per kegiatan juga. */
    const items = DB.absensi.filter(a=>a.santriId===santriId && a.kegiatanId===k.id && a.tanggal>=from && a.tanggal<=to && a.status!=='hd');
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
  /* Modal terbuka juga dicatat ke riwayat browser (lihat blok "TOMBOL
     KEMBALI" di bawah), supaya kalau pembina menekan tombol Kembali HP
     saat modal terbuka, yang tertutup cukup modal-nya saja -- bukan
     langsung keluar dari aplikasi. */
  pushAppState({modal: true, page: currentPage});
}
function closeModal(){
  const modalRoot = document.getElementById('modalRoot');
  if(modalRoot.innerHTML.trim() === '') return;
  modalRoot.innerHTML = '';
  /* Modal ini ditutup lewat tombol X / tap di luar modal / setelah Simpan
     -- BUKAN lewat tombol Kembali HP. Riwayat browser yang tadi dicatat
     saat modal dibuka jadi "nyangkut" (tidak konsisten dengan tampilan),
     jadi di sini kita bersihkan sendiri lewat history.back(). Ini memang
     ikut memicu event 'popstate', tapi ditandai lewat suppressNextPopstate
     supaya listener di bawah tidak memprosesnya dua kali. */
  if(history.state && history.state.modal){
    suppressNextPopstate = true;
    history.back();
  }
}

/* ---------- TOMBOL KEMBALI (HP/PWA) ----------
   Aplikasi ini SPA satu halaman tanpa routing browser, jadi secara
   default riwayat browser cuma berisi SATU entri -- begitu tombol
   Kembali HP ditekan, langsung keluar dari aplikasi tanpa sempat
   menutup modal atau pindah tab dulu. Supaya terasa wajar seperti
   aplikasi pada umumnya:
   - kalau ada modal terbuka -> tombol Kembali menutup modal saja.
   - kalau sedang tidak di tab pertama (mis. di Riwayat/Hafalan) ->
     tombol Kembali pindah ke tab pertama.
   - kalau sudah di tab pertama tanpa modal -> baru tombol Kembali
     benar-benar keluar dari aplikasi/PWA seperti biasa. */
function pushAppState(extra){
  try{ history.pushState(Object.assign({app:true}, extra||{}), ''); }catch(e){}
}
let suppressNextPopstate = false;
window.addEventListener('popstate', function(){
  if(suppressNextPopstate){ suppressNextPopstate = false; return; }
  const modalRoot = document.getElementById('modalRoot');
  if(modalRoot && modalRoot.innerHTML.trim() !== ''){
    modalRoot.innerHTML = '';
    return;
  }
  const nav = navForSession();
  const defaultPage = nav[0] ? nav[0].id : null;
  if(defaultPage && currentPage !== defaultPage){
    goPage(defaultPage, { fromPopstate: true });
  }
  /* kalau sudah di tab pertama & tidak ada modal, tidak dilakukan
     apa-apa di sini -- biarkan browser/OS menutup aplikasi seperti
     tombol Kembali pada umumnya. */
});

/* ---------- INIT ---------- */
initLogin();

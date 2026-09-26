const SESSION_COOKIE = 'ynf_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra}});
}
function text(data, status=200, extra={}){ return new Response(data, {status, headers:{'Content-Type':'text/plain; charset=utf-8', ...extra}}); }

function parseDate(v){
  if(!v) return null;
  const str = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(str)) {
    const [d, m, y] = str.split('/');
    return `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }
  return null;
}

export default { async fetch(req, env) {
  try {
    if(!env.DB) {
      return json({ok:false, message:'Database D1 belum terhubung ke Worker. Pastikan Variable Binding di Cloudflare dinamai "DB".'}, 500);
    }

    // Inisialisasi Tabel Transaksi jika belum ada
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, no_transaksi TEXT NOT NULL UNIQUE, tanggal TEXT NOT NULL, produk TEXT NOT NULL, nama TEXT NOT NULL, nomor TEXT NOT NULL, paket TEXT, harga REAL NOT NULL, status_pembayaran TEXT NOT NULL, jatuh_tempo TEXT, ditagihkan_ke TEXT, dibuat_pada TEXT DEFAULT CURRENT_TIMESTAMP)').run();

    const url = new URL(req.url);
    const path = url.pathname;

    // 1. ENDPOINT SIMPAN TRANSAKSI
    if(path === '/api/transaksi' && req.method === 'POST') {
      let b = {};
      try {
        b = await req.json();
      } catch(err) {
        return json({ok:false, message:'Format data JSON tidak valid'}, 400);
      }

      const rawHarga = String(b.harga || b.total || '0').replace(/[^0-9]/g, '');
      const harga = Number(rawHarga) || 0;
      const produk = String(b.produk || b.jenis_produk || 'Pulsa').trim();
      const nama = String(b.nama || b.nama_pelanggan || 'Pelanggan').trim();
      const nomor = String(b.nomor || b.nomor_hp || '-').trim();
      const status_pembayaran = String(b.status_pembayaran || b.status || 'LUNAS').toUpperCase();
      
      // Auto-generate nomor transaksi unik agar tidak pernah error duplikat (UNIQUE constraint)
      const no_transaksi = 'TRX-' + Date.now() + '-' + Math.floor(Math.random()*1000);
      const nowStr = new Date().toISOString().split('T')[0];
      const tglPilihan = parseDate(b.tanggal) || nowStr;
      const jatuhTempoPilihan = parseDate(b.jatuh_tempo) || (status_pembayaran === 'HUTANG' ? nowStr : null);

      try {
        const r = await env.DB.prepare(
          'INSERT INTO transaksi (no_transaksi, tanggal, produk, nama, nomor, paket, harga, status_pembayaran, jatuh_tempo, ditagihkan_ke) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(
          no_transaksi,
          tglPilihan,
          produk,
          nama,
          nomor,
          b.paket || '',
          harga,
          status_pembayaran,
          jatuhTempoPilihan,
          b.ditagihkan_ke || ''
        ).run();

        return json({ok:true, message:'Transaksi berhasil disimpan', id:r.meta.last_row_id, no_transaksi}, 201);
      } catch(dbErr) {
        return json({ok:false, message:'Gagal menyimpan ke DB: ' + dbErr.message}, 500);
      }
    }

    // 2. ENDPOINT AMBIL REKAP TRANSAKSI
    if(path === '/api/transaksi' && req.method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM transaksi ORDER BY id DESC LIMIT 100').all();
      return json({ok:true, data: rows.results || []}, 200);
    }

    // 3. MENAMPILKAN HALAMAN UTAMA (LANGSUNG KE MENU TRANSAKSI)
    const assetPath = (path === '/' || path === '/admin' || path === '/admin/') ? '/index.html' : path;
    const res = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin)));
    
    if (path === '/' || path === '/index.html') {
      let html = await res.text();

      // Injeksi skrip agar aplikasi langsung fokus ke form input transaksi saat pertama dibuka
      const directToTxScript = `
        <script>
          window.addEventListener('DOMContentLoaded', () => {
            // Sembunyikan modal login jika ada yang terbuka otomatis
            const loginModal = document.getElementById('loginModal') || document.querySelector('.modal-login');
            if (loginModal) loginModal.style.display = 'none';
            
            // Fokuskan layar/scroll langsung ke form input transaksi
            const txForm = document.querySelector('form') || document.getElementById('input-transaksi') || document.querySelector('.card');
            if (txForm) txForm.scrollIntoView({ behavior: 'smooth' });
          });
        </script>
      `;

      html = html.replace('</body>', `${directToTxScript}</body>`);
      return new Response(html, { headers: res.headers });
    }

    return res;
  } catch(e) {
    return json({ok:false, message:'Server Error: ' + e.message}, 500);
  }
}}

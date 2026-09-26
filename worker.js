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
    if(!env.DB) return json({ok:false, message:'Database D1 belum terhubung ke Worker (env.DB kosong).'}, 500);

    // Inisialisasi Tabel
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, no_transaksi TEXT NOT NULL UNIQUE, tanggal TEXT NOT NULL, produk TEXT NOT NULL, nama TEXT NOT NULL, nomor TEXT NOT NULL, paket TEXT, harga REAL NOT NULL, status_pembayaran TEXT NOT NULL, jatuh_tempo TEXT, ditagihkan_ke TEXT, dibuat_pada TEXT DEFAULT CURRENT_TIMESTAMP)').run();

    const url = new URL(req.url);
    const path = url.pathname;

    // ENDPOINT SIMPAN TRANSAKSI
    if(path === '/api/transaksi' && req.method === 'POST') {
      let b = {};
      try {
        b = await req.json();
      } catch(err) {
        return json({ok:false, message:'Format JSON tidak valid: ' + err.message}, 400);
      }

      // Bersihkan & Normalisasi Input
      const rawHarga = String(b.harga || b.total || '0').replace(/[^0-9]/g, '');
      const harga = Number(rawHarga) || 0;
      const produk = String(b.produk || b.jenis_produk || 'Pulsa').trim();
      const nama = String(b.nama || b.nama_pelanggan || 'Pelanggan').trim();
      const nomor = String(b.nomor || b.nomor_hp || '-').trim();
      const status_pembayaran = String(b.status_pembayaran || b.status || 'LUNAS').toUpperCase();
      
      const no_transaksi = String(b.no_transaksi || '').trim() || ('TRX-' + Date.now() + '-' + Math.floor(Math.random()*1000));
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

        return json({ok:true, message:'Berhasil disimpan', id:r.meta.last_row_id, no_transaksi}, 201);
      } catch(dbErr) {
        return json({ok:false, message:'Gagal simpan DB: ' + dbErr.message}, 500);
      }
    }

    // GET REKAP TRANSAKSI
    if(path === '/api/transaksi' && req.method === 'GET') {
      const rows = await env.DB.prepare('SELECT * FROM transaksi ORDER BY id DESC LIMIT 100').all();
      return json({ok:true, data: rows.results || []}, 200);
    }

    return env.ASSETS.fetch(req);
  } catch(e) {
    return json({ok:false, message:'Server error: ' + e.message}, 500);
  }
}}

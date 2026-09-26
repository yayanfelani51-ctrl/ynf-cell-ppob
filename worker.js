const SESSION_COOKIE = 'ynf_admin_session';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return json({ ok: true });
    }

    try {
      if (!env.DB) {
        return json({ ok: false, message: 'Database D1 belum terhubung ke Worker (env.DB tidak ditemukan).' }, 500);
      }

      // 1. Buat Tabel jika belum ada
      await env.DB.prepare(`
        CREATE TABLE IF NOT EXISTS transaksi (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          no_transaksi TEXT NOT NULL UNIQUE,
          tanggal TEXT NOT NULL,
          produk TEXT NOT NULL,
          nama TEXT NOT NULL,
          nomor TEXT NOT NULL,
          paket TEXT,
          harga REAL NOT NULL,
          status_pembayaran TEXT NOT NULL,
          jatuh_tempo TEXT,
          ditagihkan_ke TEXT,
          dibuat_pada TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      const url = new URL(req.url);
      const path = url.pathname;

      // 2. ENDPOINT SIMPAN TRANSAKSI (POST)
      if (path === '/api/transaksi' && req.method === 'POST') {
        let b;
        try {
          b = await req.json();
        } catch (e) {
          return json({ ok: false, message: 'Format data JSON dari web tidak valid.' }, 400);
        }

        const nama = String(b.nama || '').trim();
        const nomor = String(b.nomor || '').trim();
        const produk = String(b.produk || 'Pulsa').trim();
        const paket = String(b.paket || '').trim();
        const harga = Number(String(b.harga || 0).replace(/[^0-9]/g, '')) || 0;
        const status_pembayaran = String(b.status_pembayaran || 'LUNAS').toUpperCase();
        const tanggal = b.tanggal || new Date().toISOString().split('T')[0];

        if (!nama || !nomor || harga <= 0) {
          return json({ ok: false, message: 'Harap lengkapi Nama, Nomor HP, dan Harga dengan benar.' }, 400);
        }

        const no_transaksi = 'TRX-' + Date.now() + '-' + Math.floor(Math.random() * 1000);

        const result = await env.DB.prepare(`
          INSERT INTO transaksi (no_transaksi, tanggal, produk, nama, nomor, paket, harga, status_pembayaran)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(no_transaksi, tanggal, produk, nama, nomor, paket, harga, status_pembayaran).run();

        return json({
          ok: true,
          message: 'Transaksi berhasil disimpan!',
          no_transaksi: no_transaksi,
          id: result.meta.last_row_id
        }, 201);
      }

      // 3. ENDPOINT AMBIL REKAP (GET)
      if (path === '/api/transaksi' && req.method === 'GET') {
        const rows = await env.DB.prepare('SELECT * FROM transaksi ORDER BY id DESC LIMIT 100').all();
        const data = rows.results || [];

        const totalOmset = data.reduce((acc, i) => acc + (Number(i.harga) || 0), 0);
        const totalLunas = data.filter(i => i.status_pembayaran === 'LUNAS').reduce((acc, i) => acc + (Number(i.harga) || 0), 0);
        const totalHutang = data.filter(i => i.status_pembayaran === 'HUTANG').reduce((acc, i) => acc + (Number(i.harga) || 0), 0);

        return json({
          ok: true,
          data: data,
          ringkasan: { totalOmset, totalLunas, totalHutang }
        });
      }

      return env.ASSETS.fetch(req);
    } catch (err) {
      return json({ ok: false, message: 'Server Error: ' + err.message }, 500);
    }
  }
};

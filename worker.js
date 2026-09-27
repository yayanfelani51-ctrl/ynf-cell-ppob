function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

const DEFAULT_PIN = "123456";

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') {
      return json({ ok: true });
    }

    try {
      if (!env.DB) {
        return json({ ok: false, message: 'Database D1 belum terhubung.' }, 500);
      }

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
          harga_modal REAL DEFAULT 0,
          status_pembayaran TEXT NOT NULL,
          jatuh_tempo TEXT,
          dibuat_pada TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `).run();

      const url = new URL(req.url);
      const path = url.pathname;

      // 1. ENDPOINT LOGIN
      if (path === '/api/login' && req.method === 'POST') {
        const b = await req.json();
        const pinInput = String(b.pin || '').trim();

        if (pinInput === DEFAULT_PIN) {
          return json({ ok: true, message: 'Login berhasil!' });
        } else {
          return json({ ok: false, message: 'PIN / Kata Sandi salah!' }, 401);
        }
      }

      // 2. ENDPOINT HAPUS TRANSAKSI (DELETE)
      if (path === '/api/transaksi' && req.method === 'DELETE') {
        const b = await req.json();
        const id = b.id;

        if (!id) {
          return json({ ok: false, message: 'ID Transaksi wajib diisi.' }, 400);
        }

        await env.DB.prepare('DELETE FROM transaksi WHERE id = ?').bind(id).run();

        return json({ ok: true, message: 'Transaksi berhasil dihapus!' });
      }

      // 3. ENDPOINT UBAH STATUS (PUT)
      if (path === '/api/transaksi/status' && req.method === 'PUT') {
        const b = await req.json();
        const id = b.id;
        const status = String(b.status_pembayaran || 'LUNAS').toUpperCase();

        if (!id) {
          return json({ ok: false, message: 'ID Transaksi wajib diisi.' }, 400);
        }

        await env.DB.prepare(`
          UPDATE transaksi SET status_pembayaran = ? WHERE id = ?
        `).bind(status, id).run();

        return json({ ok: true, message: 'Status pembayaran berhasil diperbarui!' });
      }

      // 4. ENDPOINT SIMPAN TRANSAKSI (POST)
      if (path === '/api/transaksi' && req.method === 'POST') {
        let b = await req.json();

        const nama = String(b.nama || '').trim();
        const nomor = String(b.nomor || '').trim();
        const produk = String(b.produk || 'Pulsa').trim();
        const paket = String(b.paket || '').trim();
        const harga = Number(String(b.harga || 0).replace(/[^0-9]/g, '')) || 0;
        const harga_modal = Number(String(b.harga_modal || 0).replace(/[^0-9]/g, '')) || 0;
        const status_pembayaran = String(b.status_pembayaran || 'LUNAS').toUpperCase();
        const tanggal = b.tanggal || new Date().toISOString().split('T')[0];
        const jatuh_tempo = b.jatuh_tempo || '';

        if (!nama || !nomor || harga <= 0) {
          return json({ ok: false, message: 'Harap lengkapi data dengan benar.' }, 400);
        }

        const no_transaksi = 'YNF-' + tanggal.replace(/-/g, '') + '-' + Math.floor(10000000 + Math.random() * 90000000);

        const result = await env.DB.prepare(`
          INSERT INTO transaksi (no_transaksi, tanggal, produk, nama, nomor, paket, harga, harga_modal, status_pembayaran, jatuh_tempo)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(no_transaksi, tanggal, produk, nama, nomor, paket, harga, harga_modal, status_pembayaran, jatuh_tempo).run();

        return json({
          ok: true,
          message: 'Transaksi berhasil disimpan!',
          no_transaksi: no_transaksi,
          id: result.meta.last_row_id
        }, 201);
      }

      // 5. ENDPOINT AMBIL REKAP (GET)
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

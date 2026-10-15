export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Content-Type": "application/json"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers });

    // 1. AMBIL SEMUA TRANSAKSI (Mendukung / , /transaksi , dan /api/transaksi)
    if ((url.pathname === "/" || url.pathname === "/transaksi" || url.pathname === "/api/transaksi") && request.method === "GET") {
      try {
        const data = await env.DB.prepare("SELECT * FROM transactions ORDER BY rowid DESC").all();
        return new Response(JSON.stringify(data.results || []), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 2. SIMPAN TRANSAKSI BARU DARI APLIKASI KASIR
    if ((url.pathname === "/transaksi" || url.pathname === "/api/transaksi") && request.method === "POST") {
      try {
        const data = await request.json();
        await env.DB.prepare(
          `INSERT INTO transactions (id, no_transaksi, tanggal, nama, nomor, produk, paket, nomor_token, asal_pdam, harga_modal, harga, status_pembayaran, jatuh_tempo) 
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          String(data.id), 
          data.no_transaksi, 
          data.tanggal, 
          data.nama, 
          data.nomor, 
          data.produk, 
          data.paket || '', 
          data.nomor_token || '', 
          data.asal_pdam || '', 
          data.harga_modal || 0, 
          data.harga || 0, 
          data.status_pembayaran, 
          data.jatuh_tempo || ''
        ).run();

        return new Response(JSON.stringify({ success: true }), { headers });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(prosesPenagihanHutang(env));
  }
};

// FUNGSI PENAGIHAN OTOMATIS WHATSAPP
async function prosesPenagihanHutang(env) {
  const today = new Date().toISOString().split('T')[0];

  const data = await env.DB.prepare(
    `SELECT * FROM transactions 
     WHERE status_pembayaran = 'HUTANG' 
     AND jatuh_tempo != ? AND jatuh_tempo != ''`
  ).bind(today).all();

  const results = data.results || [];
  if (results.length === 0) return;

  for (let item of results) {
    if (!item.nomor) continue;

    let rawNo = String(item.nomor).replace(/[^0-9]/g, '');
    let noHp = rawNo.startsWith('0') ? '62' + rawNo.substring(1) : rawNo;

    let pesan = `PENGINGAT TAGIHAN YNF CELL\n\n` +
      `Halo ${item.nama},\n` +
      `Mengingatkan transaksi Anda di YNF CELL:\n` +
      `- No Trx: ${item.no_transaksi}\n` +
      `- Produk: ${item.produk}\n` +
      `- Total Tagihan: Rp ${Number(item.harga).toLocaleString('id-ID')}\n` +
      `- Tanggal Jatuh Tempo: ${item.jatuh_tempo}\n\n` +
      `Mohon untuk melakukan penyelesaian pembayaran. Terima kasih! 🙏`;

    if (env.FONNTE_TOKEN) {
      await fetch("https://api.fonnte.com/send", {
        method: "POST",
        headers: { "Authorization": env.FONNTE_TOKEN },
        body: new URLSearchParams({
          target: noHp,
          message: pesan
        })
      });
    }
  }
}

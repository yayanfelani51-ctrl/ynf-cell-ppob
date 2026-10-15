export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // HANDLE GET (Mengambil Data)
      if (request.method === "GET" && (path === "/" || path === "/transaksi" || path === "/api/transaksi")) {
        const { results } = await env.DB.prepare("SELECT * FROM transactions ORDER BY id DESC").all();
        return new Response(JSON.stringify(results || []), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // HANDLE POST (Menyimpan / Memperbarui Data)
      if (request.method === "POST" && (path === "/" || path === "/transaksi" || path === "/api/transaksi")) {
        const data = await request.json();
        
        // Cek apakah data dengan ID tersebut sudah ada di database
        const existing = await env.DB.prepare("SELECT id FROM transactions WHERE id = ?").bind(data.id).first();

        if (existing) {
          // Jika sudah ada, lakukan UPDATE (misal ubah status lunas/hutang)
          await env.DB.prepare(`
            UPDATE transactions 
            SET no_transaksi = ?, tanggal = ?, jatuh_tempo = ?, nama = ?, nomor = ?, produk = ?, paket = ?, asal_pdam = ?, harga_modal = ?, harga = ?, status_pembayaran = ?
            WHERE id = ?
          `).bind(
            data.no_transaksi || '-',
            data.tanggal || '',
            data.jatuh_tempo || '',
            data.nama || '-',
            data.nomor || '-',
            data.produk || '-',
            data.paket || '-',
            data.asal_pdam || '',
            Number(data.harga_modal) || 0,
            Number(data.harga) || 0,
            data.status_pembayaran || 'LUNAS',
            data.id
          ).run();
        } else {
          // Jika belum ada, lakukan INSERT (transaksi baru / impor)
          await env.DB.prepare(`
            INSERT INTO transactions (id, no_transaksi, tanggal, jatuh_tempo, nama, nomor, produk, paket, asal_pdam, harga_modal, harga, status_pembayaran)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(
            data.id || Date.now(),
            data.no_transaksi || '-',
            data.tanggal || '',
            data.jatuh_tempo || '',
            data.nama || '-',
            data.nomor || '-',
            data.produk || '-',
            data.paket || '-',
            data.asal_pdam || '',
            Number(data.harga_modal) || 0,
            Number(data.harga) || 0,
            data.status_pembayaran || 'LUNAS'
          ).run();
        }

        return new Response(JSON.stringify({ success: true, message: "Data berhasil diproses" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response("Endpoint tidak ditemukan", { status: 404, headers: corsHeaders });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};

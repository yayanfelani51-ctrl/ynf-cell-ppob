CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, no_transaksi TEXT NOT NULL UNIQUE, tanggal TEXT NOT NULL, produk TEXT NOT NULL, nama TEXT NOT NULL, nomor TEXT NOT NULL, paket TEXT NOT NULL, harga INTEGER NOT NULL CHECK(harga>=0), status_pembayaran TEXT NOT NULL CHECK(status_pembayaran IN ('LUNAS','HUTANG')), jatuh_tempo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS idx_transaksi_tanggal ON transaksi(tanggal);
CREATE INDEX IF NOT EXISTS idx_transaksi_status ON transaksi(status_pembayaran);
CREATE INDEX IF NOT EXISTS idx_transaksi_nama ON transaksi(nama);
CREATE INDEX IF NOT EXISTS idx_transaksi_nomor ON transaksi(nomor);

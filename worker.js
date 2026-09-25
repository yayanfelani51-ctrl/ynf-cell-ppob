const SESSION_COOKIE = 'ynf_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra}});
}
function text(data, status=200, extra={}){ return new Response(data, {status, headers:{'Content-Type':'text/plain; charset=utf-8', ...extra}}); }
function validate(v){ return /^\d{4}-\d{2}-\d{2}$/.test(String(v)) \vert{}\vert{} /^\d{2}\/\d{2}\/\d{4}$/.test(String(v)); }
function b64u(bytes){ let s=''; for(const b of bytes) s+=String.fromCharCode(b); return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
function ub64(s){ s=s.replaceAll('-','+').replaceAll('_','/'); while(s.length%4) s+='='; const bin=atob(s); return Uint8Array.from(bin, c=>c.charCodeAt(0)); }
async function hmac(secret, data){ const k=await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']); return b64u(new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data)))); }
async function makeSession(env, username){ const payload=b64u(new TextEncoder().encode(JSON.stringify({u:username, e:Date.now()+SESSION_TTL*1000}))); const sig=await hmac(env.SESSION_SECRET||'ynf-secret', payload); return `${payload}.${sig}`; }
async function readSession(req, env){ const c=req.headers.get('Cookie')||''; const m=c.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`)); if(!m) return null; const [payload, sig]=m[1].split('.'); if(!payload||!sig) return null; const expected=await hmac(env.SESSION_SECRET||'ynf-secret', payload); if(sig!==expected) return null; try{ const data=JSON.parse(new TextDecoder().decode(ub64(payload))); if(data.e<Date.now()) return null; return data; }catch{ return null; } }
function cookie(value, maxAge=SESSION_TTL){ return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`; }
async function hashPassword(password, saltBytes=crypto.getRandomValues(new Uint8Array(16))){ const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits=await crypto.subtle.deriveBits({name:'PBKDF2', salt:saltBytes, iterations:100000, hash:'SHA-256'}, key, 256); return `pbkdf2$100000$${b64u(saltBytes)}$${b64u(new Uint8Array(bits))}`; }
async function verifyPassword(password, stored){ try{ const [alg, it, salt, hash]=stored.split('$'); if(alg!=='pbkdf2') return false; const saltBytes=ub64(salt); const key=await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']); const bits=await crypto.subtle.deriveBits({name:'PBKDF2', salt:saltBytes, iterations:parseInt(it,10), hash:'SHA-256'}, key, 256); return b64u(new Uint8Array(bits))===hash; }catch{ return false; } }
async function ensureAdmin(env){ const row=await env.DB.prepare('SELECT id FROM admins LIMIT 1').first(); if(!row){ const pass=await hashPassword('admin123'); await env.DB.prepare('INSERT INTO admins (username, password_hash) VALUES (?, ?)').bind('admin', pass).run(); } }
async function requireAdmin(req, env){ return readSession(req, env); }
function headers(){ return {'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'same-origin', 'X-Frame-Options':'SAMEORIGIN'}; }

export default { async fetch(req, env) {
  try{
    if(!env.DB || !env.ASSETS) return text('Cloudflare bindings belum dikonfigurasi.', 500, headers());
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, no_transaksi TEXT NOT NULL UNIQUE, tanggal TEXT NOT NULL, produk TEXT NOT NULL, nama TEXT NOT NULL, nomor TEXT NOT NULL, paket TEXT, harga REAL NOT NULL, status_pembayaran TEXT NOT NULL, jatuh_tempo TEXT, ditagihkan_ke TEXT, dibuat_pada TEXT DEFAULT CURRENT_TIMESTAMP)').run();
    
    const url=new URL(req.url), path=url.pathname;
    
    // File Service Worker Otomatis
    if(path === '/sw.js') {
      return new Response(`self.addEventListener('fetch', function(e){});`, {
        headers: { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache' }
      });
    }

    if(path==='/health') return json({ok:true, service:'YNF CELL PPOB', database:'cloudflare-d1'}, 200, headers());
    if(path==='/api/login' && req.method==='POST'){
      await ensureAdmin(env); const b=await req.json(); const r=await env.DB.prepare('SELECT * FROM admins WHERE username=?').bind(b.username||'').first();
      if(!r || !await verifyPassword(String(b.password||''), r.password_hash)) return json({ok:false, message:'Username atau password salah.'}, 401, headers());
      const token=await makeSession(env, r.username); return json({ok:true, username:r.username}, 200, {'Set-Cookie':cookie(token), ...headers()});
    }
    if(path==='/api/logout' && req.method==='POST') return json({ok:true}, 200, {'Set-Cookie':cookie('', 0), ...headers()});
    if(path==='/api/me' && req.method==='GET'){ const s=await readSession(req, env); return json({ok:true, loggedIn:!!s, username:s?.u||null}, 200, headers()); }
    if(path==='/api/transaksi' && req.method==='POST'){
      const b=await req.json(); const harga=Number(b.harga); if(!b.no_transaksi||!b.tanggal||!b.produk||!b.nama||!b.nomor||isNaN(harga)||harga<=0) return json({ok:false, message:'Data transaksi tidak lengkap.'}, 400, headers());
      if(!['LUNAS', 'HUTANG'].includes(b.status_pembayaran)) return json({ok:false, message:'Status pembayaran tidak valid.'}, 400, headers());
      if(b.status_pembayaran==='HUTANG' && !validate(b.jatuh_tempo)) return json({ok:false, message:'Tanggal jatuh tempo wajib diisi.'}, 400, headers());
      try{ const r=await env.DB.prepare('INSERT INTO transaksi (no_transaksi, tanggal, produk, nama, nomor, paket, harga, status_pembayaran, jatuh_tempo, ditagihkan_ke) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(b.no_transaksi, b.tanggal, b.produk, b.nama, b.nomor, b.paket||'', harga, b.status_pembayaran, b.status_pembayaran==='HUTANG'?b.jatuh_tempo:null, b.ditagihkan_ke||'').run(); return json({ok:true, id:r.meta.last_row_id}, 201, headers()); }catch(e){ return json({ok:false, message:'Gagal menyimpan transaksi: '+e.message}, 400, headers()); }
    }
    if(path==='/api/rekap' && req.method==='GET'){
      if(!await requireAdmin(req, env)) return json({ok:false, message:'Silakan login sebagai admin.'}, 401, headers());
    }
    if(path==='/api/transaksi' && req.method==='GET'){
      if(!await requireAdmin(req, env)) return json({ok:false, message:'Silakan login sebagai admin.'}, 401, headers());
    }

    const assetPath = (path === '/' || path === '/admin' || path === '/admin/') ? '/index.html' : path;
    const res = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin)));
    
    // Injeksi tag PWA dan pendaftaran Service Worker
    if (path === '/' || path === '/index.html') {
      let html = await res.text();
      const pwaTags = `
        <link rel="manifest" href="/manifest.json">
        <meta name="theme-color" content="#121212">
        <meta name="mobile-web-app-capable" content="yes">
        <script>
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
          }
        </script>
      `;
      html = html.replace('</head>', `${pwaTags}</head>`);
      return new Response(html, { headers: res.headers });
    }
    
    return res;
  }catch(e){console.error(e); return json({ok:false, message:'Server error: '+e.message}, 500, headers());}
}}

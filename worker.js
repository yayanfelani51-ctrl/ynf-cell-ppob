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
    
    // API SIMPAN TRANSAKSI
    if(path==='/api/transaksi' && req.method==='POST'){
      let b = {};
      try { b = await req.json(); } catch(e){}
      
      const harga = Number(b.harga) || 0;
      const produk = String(b.produk || 'Pulsa').trim();
      const nama = String(b.nama || 'Pelanggan').trim();
      const nomor = String(b.nomor || '-').trim();
      const status_pembayaran = ['LUNAS', 'HUTANG'].includes(b.status_pembayaran) ? b.status_pembayaran : 'LUNAS';
      
      // Auto-generate nomor transaksi unik agar tidak pernah error duplikat
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
        
        return json({ok:true, id:r.meta.last_row_id, no_transaksi}, 201, headers()); 
      } catch(e) { 
        return json({ok:false, message:'Gagal menyimpan transaksi: ' + e.message}, 400, headers()); 
      }
    }
    
    // API GET REKAP TRANSAKSI
    if(path==='/api/transaksi' && req.method==='GET'){
      const rows = await env.DB.prepare('SELECT * FROM transaksi ORDER BY id DESC LIMIT 100').all();
      return json({ok:true, data: rows.results||[]}, 200, headers());
    }

    const assetPath = (path === '/' || path === '/admin' || path === '/admin/') ? '/index.html' : path;
    const res = await env.ASSETS.fetch(new Request(new URL(assetPath, url.origin)));
    
    if (path === '/' || path === '/index.html') {
      let html = await res.text();
      const session = await readSession(req, env);
      
      const autoLoginScript = !session ? `<script>
        window.addEventListener('DOMContentLoaded', () => {
          if (typeof showLoginModal === 'function') showLoginModal();
          else if (document.getElementById('btnLogin')) document.getElementById('btnLogin').click();
          else if (document.querySelector('[data-target="#loginModal"]')) document.querySelector('[data-target="#loginModal"]').click();
        });
      </script>` : '';

      const rekapScript = `
        <div id="rekapContainer" style="margin:20px 10px; padding:15px; background:#1e1e1e; color:#fff; border-radius:10px;">
          <h3 style="color:#f39c12; margin-top:0;">📋 Rekap Transaksi Terakhir</h3>
          <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:13px;">
              <thead>
                <tr style="border-bottom:2px solid #333; text-align:left; color:#aaa;">
                  <th style="padding:8px;">No Trx</th>
                  <th style="padding:8px;">Tanggal</th>
                  <th style="padding:8px;">Pelanggan</th>
                  <th style="padding:8px;">Produk</th>
                  <th style="padding:8px;">Harga</th>
                  <th style="padding:8px;">Status</th>
                </tr>
              </thead>
              <tbody id="rekapTableBody">
                <tr><td colspan="6" style="padding:10px; text-align:center;">Memuat data...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <script>
          async function loadRekapData() {
            try {
              const res = await fetch('/api/transaksi');
              const json = await res.json();
              const tbody = document.getElementById('rekapTableBody');
              if (json.ok && json.data.length > 0) {
                tbody.innerHTML = json.data.map(item => \`
                  <tr style="border-bottom:1px solid #2a2a2a;">
                    <td style="padding:8px;">\${item.no_transaksi}</td>
                    <td style="padding:8px;">\${item.tanggal}</td>
                    <td style="padding:8px;">\${item.nama}<br><small style="color:#888">\${item.nomor}</small></td>
                    <td style="padding:8px;">\${item.produk}</td>
                    <td style="padding:8px;">Rp \${Number(item.harga).toLocaleString('id-ID')}</td>
                    <td style="padding:8px;"><span style="padding:3px 6px; border-radius:4px; font-size:11px; background:\${item.status_pembayaran==='LUNAS'?'#27ae60':'#e74c3c'}">\${item.status_pembayaran}</span></td>
                  </tr>
                \`).join('');
              } else {
                tbody.innerHTML = '<tr><td colspan="6" style="padding:10px; text-align:center; color:#888;">Belum ada data transaksi.</td></tr>';
              }
            } catch(e) {
              console.error(e);
            }
          }
          window.addEventListener('DOMContentLoaded', loadRekapData);
        </script>
      `;

      const pwaTags = `
        <link rel="manifest" href="/manifest.json">
        <meta name="theme-color" content="#121212">
        <meta name="mobile-web-app-capable" content="yes">
        <script>
          if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js');
          }
        </script>
        ${autoLoginScript}
      `;
      
      html = html.replace('</head>', `${pwaTags}</head>`);
      html = html.replace('</body>', `${rekapScript}</body>`);
      
      return new Response(html, { headers: res.headers });
    }
    
    return res;
  }catch(e){console.error(e); return json({ok:false, message:'Server error: '+e.message}, 500, headers());}
}}

const SESSION_COOKIE = 'ynf_admin_session';
const SESSION_TTL = 60 * 60 * 12;

function json(data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...extra}});
}
function text(data,status=200,extra={}){return new Response(data,{status,headers:{'Content-Type':'text/plain; charset=utf-8',...extra}})}
function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''));}
function b64u(bytes){let s='';for(const b of bytes)s+=String.fromCharCode(b);return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=','')}
function ub64(s){s=s.replaceAll('-','+').replaceAll('_','/');while(s.length%4)s+='=';const bin=atob(s);return Uint8Array.from(bin,c=>c.charCodeAt(0))}
async function hmac(secret,data){const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(data)))}
async function makeSession(env, username){const payload=b64u(new TextEncoder().encode(JSON.stringify({u:username,e:Date.now()+SESSION_TTL*1000})));const sig=b64u(await hmac(env.SESSION_SECRET,payload));return payload+'.'+sig}
async function readSession(req,env){const c=req.headers.get('Cookie')||'';const m=c.match(new RegExp('(?:^|; )'+SESSION_COOKIE+'=([^;]+)'));if(!m)return null;const parts=m[1].split('.');if(parts.length!==2)return null;const expected=await hmac(env.SESSION_SECRET,parts[0]);const got=ub64(parts[1]);if(got.length!==expected.length)return null;let diff=0;for(let i=0;i<got.length;i++)diff|=got[i]^expected[i];if(diff)return null;try{const p=JSON.parse(new TextDecoder().decode(ub64(parts[0])));return p.e>Date.now()?p:null}catch{return null}}
function cookie(value,maxAge=SESSION_TTL){return `${SESSION_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`}
async function hashPassword(password,saltBytes=crypto.getRandomValues(new Uint8Array(16))){const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:saltBytes,iterations:120000,hash:'SHA-256'},key,256);return `pbkdf2$120000$${b64u(saltBytes)}$${b64u(new Uint8Array(bits))}`}
async function verifyPassword(password,stored){try{const [alg,it,salt,hash]=stored.split('$');if(alg!=='pbkdf2')return false;const saltBytes=ub64(salt);const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);const bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:saltBytes,iterations:Number(it),hash:'SHA-256'},key,256);const a=new Uint8Array(bits),b=ub64(hash);if(a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0}catch{return false}}
async function ensureAdmin(env){const row=await env.DB.prepare('SELECT id FROM admins LIMIT 1').first();if(row)return;if(!env.ADMIN_PASSWORD)throw new Error('ADMIN_PASSWORD belum diatur di Cloudflare Worker Secrets.');const username=env.ADMIN_USERNAME||'admin';const ph=await hashPassword(env.ADMIN_PASSWORD);await env.DB.prepare('INSERT OR IGNORE INTO admins(username,password_hash) VALUES(?,?)').bind(username,ph).run()}
function requireAdmin(req,env){return readSession(req,env)}
function filters(url){const q=(url.searchParams.get('q')||'').trim(), status=(url.searchParams.get('status')||'').toUpperCase(), from=url.searchParams.get('from')||'', to=url.searchParams.get('to')||'';const w=[],p=[];if(q){w.push('(no_transaksi LIKE ? OR nama LIKE ? OR nomor LIKE ? OR produk LIKE ? OR paket LIKE ?)');for(let i=0;i<5;i++)p.push('%'+q+'%')}if(status==='LUNAS'||status==='HUTANG'){w.push('status_pembayaran = ?');p.push(status)}if(validDate(from)){w.push("date(tanggal) >= date(?)");p.push(from)}if(validDate(to)){w.push("date(tanggal) <= date(?)");p.push(to)}return {where:w.length?' WHERE '+w.join(' AND '):'',params:p}}
function headers(){return {'X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','X-Frame-Options':'SAMEORIGIN'}}
export default {async fetch(req,env){
  try{
    if(!env.DB||!env.ASSETS) return text('Cloudflare bindings belum dikonfigurasi.',500,headers());
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS transaksi (id INTEGER PRIMARY KEY AUTOINCREMENT, no_transaksi TEXT NOT NULL UNIQUE, tanggal TEXT NOT NULL, produk TEXT NOT NULL, nama TEXT NOT NULL, nomor TEXT NOT NULL, paket TEXT NOT NULL, harga INTEGER NOT NULL CHECK(harga>=0), status_pembayaran TEXT NOT NULL CHECK(status_pembayaran IN (\'LUNAS\',\'HUTANG\')), jatuh_tempo TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)').run();
    const u=new URL(req.url), path=u.pathname;
    if(path==='/health') return json({ok:true,service:'YNF CELL PPOB',database:'cloudflare-d1'},200,headers());
    if(path==='/api/login' && req.method==='POST'){
      await ensureAdmin(env); const b=await req.json(); const r=await env.DB.prepare('SELECT * FROM admins WHERE username=?').bind(String(b.username||'')).first();
      if(!r || !(await verifyPassword(String(b.password||''),r.password_hash))) return json({ok:false,message:'Username atau password salah.'},401,headers());
      const token=await makeSession(env,r.username); return json({ok:true,username:r.username},200,{...headers(),'Set-Cookie':cookie(token)});
    }
    if(path==='/api/logout'&&req.method==='POST') return json({ok:true},200,{...headers(),'Set-Cookie':cookie('',0)});
    if(path==='/api/me'&&req.method==='GET'){const s=await readSession(req,env);return json({ok:true,loggedIn:!!s,username:s?.u||null},200,headers())}
    if(path==='/api/transaksi'&&req.method==='POST'){
      const b=await req.json(); const harga=Number(b.harga); if(!b.no_transaksi||!b.tanggal||!b.produk||!b.nama||!b.nomor||!b.paket||!Number.isFinite(harga)||harga<0)return json({ok:false,message:'Data transaksi belum lengkap atau harga tidak valid.'},400,headers());
      if(!['LUNAS','HUTANG'].includes(b.status_pembayaran))return json({ok:false,message:'Status pembayaran tidak valid.'},400,headers());
      if(b.status_pembayaran==='HUTANG'&&!validDate(b.jatuh_tempo))return json({ok:false,message:'Tanggal jatuh tempo wajib diisi untuk transaksi HUTANG.'},400,headers());
      try{const r=await env.DB.prepare('INSERT INTO transaksi(no_transaksi,tanggal,produk,nama,nomor,paket,harga,status_pembayaran,jatuh_tempo) VALUES(?,?,?,?,?,?,?,?,?) RETURNING *').bind(String(b.no_transaksi),String(b.tanggal),String(b.produk),String(b.nama),String(b.nomor),String(b.paket),Math.round(harga),b.status_pembayaran,b.status_pembayaran==='HUTANG'?b.jatuh_tempo:null).first();return json({ok:true,transaksi:r},201,headers())}catch(e){return json({ok:false,message:String(e).includes('UNIQUE')?'Nomor transaksi sudah tersimpan.':'Gagal menyimpan transaksi.'},409,headers())}
    }
    if(path==='/api/rekap'&&req.method==='GET'){
      if(!(await requireAdmin(req,env)))return json({ok:false,message:'Silakan login sebagai admin.'},401,headers()); const f=filters(u);const r=await env.DB.prepare(`SELECT COUNT(*) jumlah, COALESCE(SUM(harga),0) omzet, SUM(CASE WHEN status_pembayaran='LUNAS' THEN 1 ELSE 0 END) lunas_jumlah, COALESCE(SUM(CASE WHEN status_pembayaran='LUNAS' THEN harga ELSE 0 END),0) lunas_total, SUM(CASE WHEN status_pembayaran='HUTANG' THEN 1 ELSE 0 END) hutang_jumlah, COALESCE(SUM(CASE WHEN status_pembayaran='HUTANG' THEN harga ELSE 0 END),0) hutang_total FROM transaksi${f.where}`).bind(...f.params).first();return json({ok:true,...r},200,headers())
    }
    if(path==='/api/transaksi'&&req.method==='GET'){
      if(!(await requireAdmin(req,env)))return json({ok:false,message:'Silakan login sebagai admin.'},401,headers()); const f=filters(u);const limit=Math.min(Math.max(Number(u.searchParams.get('limit'))||500,1),5000);const r=await env.DB.prepare(`SELECT * FROM transaksi${f.where} ORDER BY id DESC LIMIT ?`).bind(...f.params,limit).all();return json({ok:true,transaksi:r.results},200,headers())
    }
    const assetPath=path==='/admin'||path==='/admin/'?'/admin/index.html':path; return env.ASSETS.fetch(new Request(new URL(assetPath,req.url),req));
  }catch(e){console.error(e);return json({ok:false,message:'Server error: '+e.message},500,headers())}
}}

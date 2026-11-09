// Fazha order server for Cloudflare (Workers + D1 database). It answers the same addresses as server.js,
// so the website works the same. Needs: a D1 database bound as DB, and a secret named ADMIN_PASSWORD.
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const IMG = /^data:image\/[\w.+-]+;base64,[A-Za-z0-9+\/=]+$/;
const img = (s, max) => (typeof s === "string" && s.length <= max && IMG.test(s) ? s : "");
const refs = a => (Array.isArray(a) ? a.map(x => img(x, 700000)).filter(Boolean).slice(0, 3) : []);
const HEAD = {
  "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-admin, ngrok-skip-browser-warning",
  "Access-Control-Max-Age": "86400", "Cache-Control": "no-store"
};
const reply = (code, data) => new Response(typeof data === "string" ? data : JSON.stringify(data),
  { status: code, headers: { ...HEAD, "Content-Type": "application/json" } });
const sha = async s => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(s))));
const marks = a => a.map(() => "?").join(",");
const fails = new Map();
let ready = null;
const init = db => (ready = ready || db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS orders (k TEXT PRIMARY KEY, o TEXT NOT NULL, ev TEXT NOT NULL, ts INTEGER NOT NULL, u INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS imgs (k TEXT NOT NULL, n TEXT NOT NULL, d TEXT NOT NULL, PRIMARY KEY (k, n))")
]).catch(e => { ready = null; throw e; }));

async function adminOk(req, env) { // 1 = ok, 0 = wrong password, -1 = too many wrong tries from this address
  const ip = req.headers.get("CF-Connecting-IP") || "?", now = Date.now();
  const f = (fails.get(ip) || []).filter(t => now - t < 6e5);
  fails.set(ip, f);
  if (f.length >= 10) return -1;
  const [a, b] = await Promise.all([sha(req.headers.get("x-admin") || ""), sha(env.ADMIN_PASSWORD || "")]);
  let d = 0; for (let i = 0; i < 32; i++) d |= a[i] ^ b[i];
  if (d === 0 && env.ADMIN_PASSWORD) return 1;
  f.push(now); return 0;
}

// Save one order (small text) plus its pictures (stored in their own rows) in one step.
const put = (db, key, order, prev, kind, files) => {
  const ev = ((prev && JSON.parse(prev.ev)) || []).concat({ kind: clip(kind, 20), at: Date.now() }).slice(-50);
  return db.batch([
    db.prepare("INSERT OR REPLACE INTO orders (k,o,ev,ts,u) VALUES (?,?,?,?,?)").bind(key, JSON.stringify(order), JSON.stringify(ev), order.ts, Date.now()),
    ...files.map(([n, d]) => db.prepare("INSERT OR REPLACE INTO imgs (k,n,d) VALUES (?,?,?)").bind(key, n, d))
  ]);
};

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEAD });
    try {
      const url = new URL(req.url), p = url.pathname, post = req.method === "POST", db = env.DB;
      if (p === "/") return reply(200, { ok: true, database: !!db, adminPassword: !!env.ADMIN_PASSWORD });
      if (!db) return reply(500, { error: "database not connected" });
      await init(db);
      const body = async () => { const t = await req.text(); if (t.length > 6e6) throw new SyntaxError("too big"); return JSON.parse(t); };
      const deny = async () => { const a = await adminOk(req, env); return a === 1 ? null : reply(a < 0 ? 429 : 401, { error: "no" }); };

      // Customer sends or updates their own order (name, email, description, payment, receipt)
      if (p === "/api/orders" && post) {
        const { kind, order: o } = await body();
        if (!o || !/^[A-Za-z0-9]{1,12}$/.test(String(o.id)) || !(+o.ts > 0)) return reply(400, { error: "bad order" });
        const key = o.id + "-" + o.ts, prev = await db.prepare("SELECT o, ev FROM orders WHERE k=?").bind(key).first();
        if (!prev && (await db.prepare("SELECT COUNT(*) c FROM orders").first()).c >= 5000) return reply(429, { error: "full" });
        const rc = img(o.rcpt, 1500000), files = rc ? [["rcpt", rc]] : [], old = prev && JSON.parse(prev.o);
        const order = old
          ? { ...old, paid: old.paid || !!o.paid, pm: clip(o.pm, 30) || old.pm, hr: old.hr || !!rc }
          : { id: String(o.id), ts: +o.ts, name: clip(o.name, 200), email: clip(o.email, 200), desc: clip(o.desc, 5000), pkg: clip(o.pkg, 100), dt: clip(o.dt, 50),
              price: +o.price || 0, ntr: !!o.ntr, paid: !!o.paid, pm: clip(o.pm, 30), status: 0, rej: false, why: "", appr: 0, hr: !!rc, ha: false };
        if (!old) refs(o.ref).forEach((r, i) => files.push(["r" + i, r]));
        await put(db, key, order, prev, kind, files);
        return reply(200, { ok: true });
      }

      // Customer's browser asks: did the shop approve / deliver my orders? (order number, time and email must match)
      if (p === "/api/sync" && post) {
        const qs = (((await body()).orders) || []).filter(q => q && q.id != null && q.ts != null).slice(0, 90);
        const keys = qs.map(q => q.id + "-" + q.ts), out = {}, want = [], rows = {};
        if (!keys.length) return reply(200, out);
        for (const r of (await db.prepare(`SELECT k, o FROM orders WHERE k IN (${marks(keys)})`).bind(...keys).all()).results) rows[r.k] = JSON.parse(r.o);
        qs.forEach((q, i) => {
          const o = rows[keys[i]];
          out[keys[i]] = o && String(o.email).toLowerCase() === String(q.email).toLowerCase()
            ? { status: o.status, rej: o.rej, why: o.why, appr: o.appr || 0, paid: o.paid, rc: !!o.hr, art: "" } : null;
          if (out[keys[i]] && o.ha && !q.a) want.push(keys[i]);
        });
        if (want.length) for (const r of (await db.prepare(`SELECT k, d FROM imgs WHERE n='art' AND k IN (${marks(want)})`).bind(...want).all()).results) out[r.k].art = r.d;
        return reply(200, out);
      }

      // Admin: approve / reject / status / finished art
      if (p === "/api/update" && post) {
        const no = await deny(); if (no) return no;
        const { key, fields: f } = await body(), k = String(key);
        const prev = await db.prepare("SELECT o, ev FROM orders WHERE k=?").bind(k).first();
        if (!prev) return reply(404, { error: "no such order" });
        const art = img(f.art, 1800000);
        const order = { ...JSON.parse(prev.o), status: Math.min(3, Math.max(0, +f.status || 0)), rej: !!f.rej, why: clip(f.why, 80), appr: +f.appr || 0, paid: !!f.paid };
        if (art) order.ha = true;
        await put(db, k, order, prev, "admin", art ? [["art", art]] : []);
        return reply(200, { ok: true });
      }

      // Admin: every order (only sent again when something changed). Pictures are included for the 40 newest orders.
      if (p === "/api/orders" && req.method === "GET") {
        const no = await deny(); if (no) return no;
        const rev = (await db.prepare("SELECT MAX(u) m FROM orders").first()).m || 1;
        if (url.searchParams.get("rev") == rev) return reply(200, { rev, same: true });
        const [os, im] = await Promise.all([
          db.prepare("SELECT k, o, ev FROM orders ORDER BY ts DESC").all(),
          db.prepare("SELECT k, n, d FROM imgs WHERE k IN (SELECT k FROM orders ORDER BY ts DESC LIMIT 40)").all()]);
        const by = {}, q = s => '"' + (s || "") + '"';
        for (const x of im.results) (by[x.k] = by[x.k] || {})[x.n] = x.d;
        const list = os.results.map(r => { const m = by[r.k] || {};
          return '{"order":' + r.o.slice(0, -1) + ',"rcpt":' + q(m.rcpt) + ',"art":' + q(m.art) + ',"ref":['
            + ["r0", "r1", "r2"].filter(n => m[n]).map(n => q(m[n])).join(",") + ']},"events":' + r.ev + "}"; });
        return reply(200, '{"rev":' + rev + ',"orders":[' + list.join(",") + "]}");
      }
      return reply(404, { error: "not found" });
    } catch (e) {
      console.log(String(e));
      return reply(e instanceof SyntaxError || e instanceof TypeError ? 400 : 500, { error: "bad request" });
    }
  }
};

// Fazha order server. Run:  node server.js   then in a second window:  ngrok http 3000
const http = require("http"), fs = require("fs"), path = require("path"), crypto = require("crypto");
const PORT = process.env.PORT || 3000, ROOT = __dirname, DATA = path.join(ROOT, "data");
fs.mkdirSync(DATA, { recursive: true });
const DB = path.join(DATA, "orders.json"), LOG = path.join(DATA, "log.jsonl");

// Admin password: the text in quotes below. Nothing else can change it (no environment variable, no password file).
const PASS = "tp144922";

let db = {}, REV = Date.now();
try { db = JSON.parse(fs.readFileSync(DB, "utf8")); } catch (_) {}
const persist = () => { fs.writeFileSync(DB + ".tmp", JSON.stringify(db)); fs.renameSync(DB + ".tmp", DB); };
const clip = (s, n) => String(s == null ? "" : s).slice(0, n);
const refs = a => (Array.isArray(a) ? a.filter(x => typeof x === "string" && x.startsWith("data:image/") && x.length <= 700000).slice(0, 3) : []);
const img = s => (typeof s === "string" && s.startsWith("data:image/") ? s : "");
const same = (a, b) => { a = Buffer.from(String(a || "")); b = Buffer.from(b); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const fails = new Map();
// Who is asking? Behind a tunnel or proxy (ngrok etc.) the real visitor is the LAST address it added to X-Forwarded-For; anything earlier is written by the visitor and can be faked, so it is ignored. If the connection did not come from a tunnel or proxy on this machine or network, the header is not trusted at all.
const privateIp = a => /^(::1$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd][0-9a-f]{2}:|::ffff:(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.))/i.test(a);
const clientIp = req => {
  const peer = req.socket.remoteAddress || "", xs = String(req.headers["x-forwarded-for"] || "").split(",").map(x => x.trim()).filter(Boolean);
  return privateIp(peer) && xs.length ? xs[xs.length - 1] : peer;
};
const adminOk = req => { // 1 = ok, 0 = wrong password, -1 = too many wrong tries from this address
  const ip = clientIp(req);
  const f = (fails.get(ip) || []).filter(t => Date.now() - t < 6e5);
  fails.set(ip, f);
  if (f.length >= 10) return -1;
  if (same(req.headers["x-admin"], PASS)) return 1;
  f.push(Date.now()); return 0;
};
const record = (key, order, kind) => {
  const ev = { kind: clip(kind, 20), at: Date.now() }, prev = db[key];
  db[key] = { order, events: ((prev && prev.events) || []).concat(ev).slice(-50) };
  REV = Math.max(REV + 1, Date.now());
  persist();
  fs.appendFile(LOG, JSON.stringify(Object.assign({}, ev, { order: Object.assign({}, order, { rcpt: order.rcpt ? "(receipt)" : "", art: order.art ? "(art)" : "", ref: order.ref && order.ref.length ? "(pictures)" : "" }) })) + "\n", () => {});
  console.log(`${new Date().toLocaleString()}  ${ev.kind}  #${order.id}  ${order.name} <${order.email}>  ${order.pkg} RM ${order.price}`);
};
const readBody = req => new Promise((ok, no) => {
  const parts = []; let n = 0;
  req.on("data", d => { n += d.length; if (n > 12e6) { no(new Error("too big")); req.destroy(); } else parts.push(d); });
  req.on("end", () => ok(Buffer.concat(parts).toString()));
  req.on("error", no);
});
const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const send = (code, data, type) => {
    res.writeHead(code, { "Content-Type": type || "application/json", "Cache-Control": "no-store" });
    res.end(typeof data === "object" && !Buffer.isBuffer(data) ? JSON.stringify(data) : data);
  };
  try {
    const url = new URL(req.url, "http://x"), p = decodeURIComponent(url.pathname), post = req.method === "POST";
    const need = () => { const a = adminOk(req); if (a !== 1) send(a < 0 ? 429 : 401, { error: "no" }); return a === 1; };

    // Customer sends or updates their own order (name, email, description, payment, receipt)
    if (p === "/api/orders" && post) {
      const { kind, order: o } = JSON.parse(await readBody(req));
      if (!o || !/^[A-Za-z0-9]{1,12}$/.test(String(o.id)) || !(+o.ts > 0)) return send(400, { error: "bad order" });
      const key = o.id + "-" + o.ts, prev = db[key];
      if (!prev && Object.keys(db).length >= 5000) return send(429, { error: "full" });
      const order = prev
        ? Object.assign({}, prev.order, { paid: prev.order.paid || !!o.paid, pm: clip(o.pm, 30) || prev.order.pm, rcpt: img(o.rcpt) || prev.order.rcpt || "", ref: prev.order.ref || refs(o.ref) })
        : { id: String(o.id), ts: +o.ts, name: clip(o.name, 200), email: clip(o.email, 200), desc: clip(o.desc, 5000), pkg: clip(o.pkg, 100), dt: clip(o.dt, 50),
            price: +o.price || 0, ntr: !!o.ntr, paid: !!o.paid, pm: clip(o.pm, 30), rcpt: img(o.rcpt), ref: refs(o.ref), status: 0, rej: false, why: "", appr: 0, art: "" };
      record(key, order, kind);
      return send(200, { ok: true });
    }
    // Customer's browser asks: did the shop approve / deliver my orders? (needs order number, time and email to match)
    if (p === "/api/sync" && post) {
      const out = {};
      for (const q of ((JSON.parse(await readBody(req)).orders) || []).slice(0, 200)) {
        const k = q.id + "-" + q.ts, o = db[k] && db[k].order;
        out[k] = o && String(o.email).toLowerCase() === String(q.email).toLowerCase()
          ? { status: o.status, rej: o.rej, why: o.why, appr: o.appr || 0, paid: o.paid, rc: !!o.rcpt, art: q.a ? "" : o.art || "" } : null;
      }
      return send(200, out);
    }
    // Admin: approve / reject / status / finished art
    if (p === "/api/update" && post) {
      if (!need()) return;
      const { key, fields: f } = JSON.parse(await readBody(req)), c = db[key];
      if (!c) return send(404, { error: "no such order" });
      record(key, Object.assign({}, c.order, { status: Math.min(3, Math.max(0, +f.status || 0)), rej: !!f.rej, why: clip(f.why, 80), appr: +f.appr || 0, paid: !!f.paid, art: img(f.art) }), "admin");
      return send(200, { ok: true });
    }
    // Admin: every order (only sent again when something changed)
    if (p === "/api/orders" && req.method === "GET") {
      if (!need()) return;
      return send(200, url.searchParams.get("rev") == REV ? { rev: REV, same: true }
        : { rev: REV, orders: Object.values(db).sort((a, b) => b.order.ts - a.order.ts) });
    }
    if (p === "/" || p === "/index.html") return send(200, fs.readFileSync(path.join(ROOT, "index.html")), "text/html; charset=utf-8");
    if (p === "/admin" || p === "/admin.html") return send(200, fs.readFileSync(path.join(ROOT, "admin.html")), "text/html; charset=utf-8");
    const f = path.join(ROOT, path.normalize(p)), ext = path.extname(f).toLowerCase();
    if (f.startsWith(ROOT + path.sep) && !f.startsWith(DATA + path.sep) && MIME[ext] && fs.existsSync(f))
      return send(200, fs.readFileSync(f), MIME[ext]);
    send(404, "Not found", "text/plain");
  } catch (_) { send(400, { error: "bad request" }); }
}).listen(PORT, () => {
  console.log(`\nSite:   http://localhost:${PORT}\nAdmin password: ${PASS}\n\nNow run in a second window:  ngrok http ${PORT}\nThen open the ngrok link, tap Log in, and use your admin email + the password above.\n`);
});

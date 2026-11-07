// Pares Tayo HQ suggestion box API (Cloudflare Pages Functions + D1).
// Needs a D1 binding named DB. Optional secret ADMIN_KEY enables moderation.
const CATS = ["Feature", "Food & recipes", "Map", "Bug", "Other"];
const STATUSES = ["", "planned", "added", "no"];
const BAD = ["tangina", "putang", "gago", "fuck", "shit", "bitch", "nigg", "puta", "ulol", "pakyu"];
const MAX_PER_HOUR = 3;

let ready = false;
async function init(db) {
  if (ready) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS suggestions (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, cat TEXT, name TEXT, author TEXT, created INTEGER, votes INTEGER DEFAULT 0, status TEXT DEFAULT '', hidden INTEGER DEFAULT 0)"),
    db.prepare("CREATE TABLE IF NOT EXISTS votes (sid TEXT, voter TEXT, PRIMARY KEY (sid, voter))"),
    db.prepare("CREATE TABLE IF NOT EXISTS posts (voter TEXT, at INTEGER)"),
  ]);
  ready = true;
}

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function voterId(request) {
  const ip = request.headers.get("CF-Connecting-IP") || "0.0.0.0";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("parestayo|" + ip));
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function clean(s, max) {
  return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
function blocked(text) {
  const t = text.toLowerCase();
  if (/https?:|www\.|\.com\b|\.net\b|discord\.gg/.test(t)) return "Links aren't allowed in suggestions.";
  if (BAD.some((w) => t.includes(w))) return "Please keep it friendly. Bad words aren't allowed.";
  return null;
}

export async function onRequest(context) {
  const { request, env, params } = context;
  if (!env.DB) return json({ error: "The suggestion box isn't set up yet." }, 503);
  const db = env.DB;
  await init(db);
  const route = (params.route || []).join("/");
  const method = request.method;
  const me = await voterId(request);

  try {
    if (route === "suggestions" && method === "GET") {
      const sort = new URL(request.url).searchParams.get("sort") === "new" ? "created DESC" : "votes DESC, created DESC";
      const { results } = await db.prepare(
        `SELECT s.id, s.title, s.body, s.cat, s.name, s.created, s.votes, s.status, (s.author = ?1) AS mine,
                EXISTS(SELECT 1 FROM votes v WHERE v.sid = s.id AND v.voter = ?1) AS voted
         FROM suggestions s WHERE s.hidden = 0 ORDER BY ${sort} LIMIT 200`
      ).bind(me).all();
      return json({ items: results });
    }

    if (route === "suggestions" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const title = clean(body.title, 80);
      const details = clean(body.body, 500);
      const name = clean(body.name, 24);
      const cat = CATS.includes(body.cat) ? body.cat : "Other";
      if (title.length < 4) return json({ error: "Write a bit more about your idea (at least 4 letters)." }, 400);
      const bad = blocked(title + " " + details + " " + name);
      if (bad) return json({ error: bad }, 400);
      const hourAgo = Date.now() - 3600_000;
      const recent = await db.prepare("SELECT COUNT(*) AS n FROM posts WHERE voter = ? AND at > ?").bind(me, hourAgo).first();
      if ((recent?.n || 0) >= MAX_PER_HOUR) return json({ error: "You've sent 3 ideas this hour. Try again later!" }, 429);
      const dupe = await db.prepare("SELECT id FROM suggestions WHERE lower(title) = lower(?) AND hidden = 0").bind(title).first();
      if (dupe) return json({ error: "Someone already suggested that! Vote for it instead." }, 409);
      const id = crypto.randomUUID().slice(0, 8);
      await db.batch([
        db.prepare("INSERT INTO suggestions (id, title, body, cat, name, author, created, votes) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").bind(id, title, details, cat, name, me, Date.now()),
        db.prepare("INSERT OR IGNORE INTO votes (sid, voter) VALUES (?, ?)").bind(id, me),
        db.prepare("INSERT INTO posts (voter, at) VALUES (?, ?)").bind(me, Date.now()),
        db.prepare("DELETE FROM posts WHERE at < ?").bind(hourAgo),
      ]);
      return json({ ok: true, id });
    }

    if (route === "vote" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      const sid = clean(body.id, 16);
      const exists = await db.prepare("SELECT id FROM suggestions WHERE id = ? AND hidden = 0").bind(sid).first();
      if (!exists) return json({ error: "That suggestion is gone." }, 404);
      const had = await db.prepare("SELECT 1 AS x FROM votes WHERE sid = ? AND voter = ?").bind(sid, me).first();
      if (had) {
        await db.batch([
          db.prepare("DELETE FROM votes WHERE sid = ? AND voter = ?").bind(sid, me),
          db.prepare("UPDATE suggestions SET votes = (SELECT COUNT(*) FROM votes WHERE sid = ?1) WHERE id = ?1").bind(sid),
        ]);
      } else {
        await db.batch([
          db.prepare("INSERT OR IGNORE INTO votes (sid, voter) VALUES (?, ?)").bind(sid, me),
          db.prepare("UPDATE suggestions SET votes = (SELECT COUNT(*) FROM votes WHERE sid = ?1) WHERE id = ?1").bind(sid),
        ]);
      }
      const row = await db.prepare("SELECT votes FROM suggestions WHERE id = ?").bind(sid).first();
      return json({ ok: true, voted: !had, votes: row?.votes || 0 });
    }

    if (route === "admin" && method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (!env.ADMIN_KEY || body.key !== env.ADMIN_KEY) return json({ error: "Wrong admin key." }, 403);
      const sid = clean(body.id, 16);
      if (body.action === "hide") await db.prepare("UPDATE suggestions SET hidden = 1 WHERE id = ?").bind(sid).run();
      else if (body.action === "status" && STATUSES.includes(body.status)) await db.prepare("UPDATE suggestions SET status = ? WHERE id = ?").bind(body.status, sid).run();
      else return json({ error: "Unknown action." }, 400);
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (e) {
    return json({ error: "Something went wrong. Try again." }, 500);
  }
}

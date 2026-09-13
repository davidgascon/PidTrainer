/**
 * Loop Lab server.
 *
 * Serves the built frontend and a small leaderboard API. Scores live in a
 * single JSON file rather than a database — a few hundred rows of name and
 * time does not justify a Postgres container, and a flat file is trivial to
 * back up and to read when something looks wrong.
 *
 * Env:
 *   PORT        default 3000
 *   DATA_DIR    default /data
 *   ADMIN_PIN   required to edit or delete a score
 */

import express from "express";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || "/data";
const DATA_FILE = path.join(DATA_DIR, "leaderboard.json");
const ADMIN_PIN = String(process.env.ADMIN_PIN || "");
const DIST = path.join(__dirname, "..", "dist");

// Challenge ids the API will accept. Anything else is rejected, so a typo in
// the client can't quietly create a phantom board nobody can find.
const CHALLENGES = [
  "duct-static", "chw-dp", "vav-flow", "dhw-temp",
  "static-filters", "static-sluggish", "dp-noreset",
  "bldg-static", "vav-chatter", "dhw-copied",
];

const NAME_MAX = 20;
const MIN_SECONDS = 5;        // nothing legitimate finishes faster
const MAX_SECONDS = 86400;

/* ---------------- storage ---------------- */

let board = { scores: [] };
let writing = Promise.resolve();

function loadSync() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (raw && Array.isArray(raw.scores)) board = raw;
    }
  } catch (err) {
    // A corrupt file should not take the whole app down. Move it aside so the
    // app starts clean and the old one is still there to look at.
    console.error("could not read leaderboard, starting empty:", err.message);
    try { fs.renameSync(DATA_FILE, DATA_FILE + ".broken-" + Date.now()); } catch {}
    board = { scores: [] };
  }
}

// Serialised, atomic writes: temp file then rename, so a crash mid-write
// cannot leave a half-written leaderboard behind.
function save() {
  writing = writing.then(async () => {
    const tmp = DATA_FILE + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(board, null, 2));
    await fsp.rename(tmp, DATA_FILE);
  }).catch((err) => console.error("leaderboard write failed:", err.message));
  return writing;
}

/* ---------------- helpers ---------------- */

const clean = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")   // control characters
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_MAX);

const key = (challenge, name) => `${challenge}::${name.toLowerCase()}`;

function pinOk(supplied) {
  const a = Buffer.from(String(supplied ?? ""));
  const b = Buffer.from(ADMIN_PIN);
  // Compare every time, even on length mismatch, so response timing does not
  // leak the PIN's length.
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

function ranked(challenge) {
  return board.scores
    .filter((s) => s.challenge === challenge)
    .sort((a, b) => a.seconds - b.seconds || a.at - b.at)
    .map((s, i) => ({ ...s, rank: i + 1 }));
}

// Crude per-IP throttle. Enough to stop an accidental loop hammering the file;
// not a serious defence, and not trying to be.
const hits = new Map();
function throttle(bucket, limit, windowMs) {
  return (req, res, next) => {
    // Key by bucket as well as IP. Sharing one counter across routes means
    // ordinary score submissions eat the admin endpoint's smaller allowance.
    const k = `${bucket}:${req.ip || "unknown"}`;
    const now = Date.now();
    const rec = hits.get(k) || { n: 0, reset: now + windowMs };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + windowMs; }
    rec.n += 1;
    hits.set(k, rec);
    if (rec.n > limit) return res.status(429).json({ error: "slow down" });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of hits) if (now > rec.reset) hits.delete(k);
}, 60_000).unref();

/* ---------------- app ---------------- */

const app = express();
app.set("trust proxy", 1);        // sits behind nginx proxy manager
app.use(express.json({ limit: "8kb" }));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.get("/healthz", (_req, res) => res.type("text").send("ok\n"));

app.get("/api/challenges", (_req, res) => res.json({ challenges: CHALLENGES }));

// Presence. Deliberately forgetful: ids are random and generated in the
// browser, nothing is written to disk, no IPs are kept, and a session drops
// off 45s after its last heartbeat. Restarting resets the count to zero.
const PRESENCE_TTL_MS = 45_000;
const presence = new Map();

setInterval(() => {
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  for (const [id, t] of presence) if (t < cutoff) presence.delete(id);
}, 10_000).unref();

app.get("/api/presence", throttle("presence", 120, 60_000), (req, res) => {
  const id = req.query.id;
  // Ignore implausible ids, and cap the map so nobody can inflate the count.
  if (typeof id === "string" && /^[a-zA-Z0-9-]{8,64}$/.test(id) && presence.size < 5000) {
    presence.set(id, Date.now());
  }
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  let count = 0;
  for (const t of presence.values()) if (t >= cutoff) count++;
  res.set("Cache-Control", "no-store").json({ count });
});

app.get("/api/board", (req, res) => {
  const c = req.query.challenge;
  if (c) {
    if (!CHALLENGES.includes(c)) return res.status(400).json({ error: "unknown challenge" });
    return res.json({ challenge: c, scores: ranked(c) });
  }
  const all = {};
  for (const id of CHALLENGES) all[id] = ranked(id);
  res.json({ boards: all });
});

// Submit a time. One row per name per challenge — a better time replaces the
// old one, a worse time is kept off the board entirely.
app.post("/api/score", throttle("score", 60, 60_000), async (req, res) => {
  const challenge = String(req.body?.challenge ?? "");
  const name = clean(req.body?.name);
  const seconds = Number(req.body?.seconds);

  if (!CHALLENGES.includes(challenge)) return res.status(400).json({ error: "unknown challenge" });
  if (!name) return res.status(400).json({ error: "name required" });
  if (!Number.isFinite(seconds) || seconds < MIN_SECONDS || seconds > MAX_SECONDS) {
    return res.status(400).json({ error: "implausible time" });
  }

  const rounded = Math.round(seconds);
  const k = key(challenge, name);
  const existing = board.scores.find((s) => key(s.challenge, s.name) === k);

  if (existing) {
    if (rounded >= existing.seconds) {
      return res.json({
        improved: false, best: existing.seconds,
        scores: ranked(challenge),
        message: `Your best on this challenge is still ${existing.seconds}s.`,
      });
    }
    existing.seconds = rounded;
    existing.name = name;        // keep the latest capitalisation
    existing.at = Date.now();
  } else {
    board.scores.push({
      id: crypto.randomUUID(),
      challenge, name, seconds: rounded, at: Date.now(),
    });
  }

  await save();
  const scores = ranked(challenge);
  res.json({
    improved: true,
    best: rounded,
    rank: scores.find((s) => key(s.challenge, s.name) === k)?.rank ?? null,
    scores,
  });
});

/* ---------------- admin ---------------- */

const requirePin = (req, res, next) => {
  if (!ADMIN_PIN) return res.status(503).json({ error: "admin disabled: ADMIN_PIN is not set" });
  const supplied = req.get("x-admin-pin") ?? req.body?.pin;
  if (!pinOk(supplied)) return res.status(403).json({ error: "wrong PIN" });
  next();
};

app.post("/api/admin/check", throttle("pin", 10, 60_000), requirePin, (_req, res) => res.json({ ok: true }));

app.patch("/api/score/:id", throttle("admin", 60, 60_000), requirePin, async (req, res) => {
  const row = board.scores.find((s) => s.id === req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });

  if (req.body?.name != null) {
    const name = clean(req.body.name);
    if (!name) return res.status(400).json({ error: "name required" });
    // Renaming onto a name that already has a time would create a duplicate
    // entry, so merge into whichever time is better.
    const clash = board.scores.find(
      (s) => s.id !== row.id && key(s.challenge, s.name) === key(row.challenge, name)
    );
    if (clash) {
      clash.seconds = Math.min(clash.seconds, row.seconds);
      clash.name = name;
      board.scores = board.scores.filter((s) => s.id !== row.id);
      await save();
      return res.json({ merged: true, scores: ranked(clash.challenge) });
    }
    row.name = name;
  }

  if (req.body?.seconds != null) {
    const secs = Number(req.body.seconds);
    if (!Number.isFinite(secs) || secs < MIN_SECONDS || secs > MAX_SECONDS) {
      return res.status(400).json({ error: "implausible time" });
    }
    row.seconds = Math.round(secs);
  }

  await save();
  res.json({ ok: true, scores: ranked(row.challenge) });
});

app.delete("/api/score/:id", throttle("admin", 60, 60_000), requirePin, async (req, res) => {
  const row = board.scores.find((s) => s.id === req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  board.scores = board.scores.filter((s) => s.id !== row.id);
  await save();
  res.json({ ok: true, scores: ranked(row.challenge) });
});

/* ---------------- static frontend ---------------- */

if (fs.existsSync(DIST)) {
  app.use("/assets", express.static(path.join(DIST, "assets"), {
    immutable: true, maxAge: "1y",
  }));
  app.use(express.static(DIST, { index: false, maxAge: "1h" }));
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api/")) return next();
    res.set("Cache-Control", "no-cache, must-revalidate");
    res.sendFile(path.join(DIST, "index.html"));
  });
}

app.use((req, res) => res.status(404).json({ error: "not found" }));

loadSync();

if (!ADMIN_PIN) {
  console.warn("ADMIN_PIN is not set — leaderboard editing and deletion are disabled.");
}

const server = app.listen(PORT, () => {
  console.log(`loop-lab listening on ${PORT}, data in ${DATA_FILE}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

export { app };

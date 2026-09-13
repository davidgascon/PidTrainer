/**
 * Leaderboard API tests. Starts the real server against a scratch data dir
 * and exercises it over HTTP.
 *   npm run test:api
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "looplab-"));
const PIN = "22136969";
const PORT = 3457;
const base = `http://127.0.0.1:${PORT}`;

const proc = spawn(process.execPath, ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, ADMIN_PIN: PIN },
  stdio: ["ignore", "pipe", "pipe"],
});
proc.stderr.on("data", d => { const s = String(d); if (!s.includes("ADMIN_PIN")) process.stderr.write(s); });

const out = [];
const check = (n, ok, extra = "") => out.push(`${ok ? "pass" : "FAIL"}  ${n}${ok ? "" : "  <- " + extra}`);

async function ready() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + "/healthz")).ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server never came up");
}

const post = (p, body, pin) => fetch(base + p, {
  method: "POST", headers: { "content-type": "application/json", ...(pin ? { "x-admin-pin": pin } : {}) },
  body: JSON.stringify(body),
});
const send = (m, p, body, pin) => fetch(base + p, {
  method: m, headers: { "content-type": "application/json", ...(pin ? { "x-admin-pin": pin } : {}) },
  body: body ? JSON.stringify(body) : undefined,
});
const board = async (c) => (await (await fetch(`${base}/api/board?challenge=${c}`)).json()).scores;

try {
  await ready();
  const C = "duct-static";

  check("health responds", (await fetch(base + "/healthz")).ok);
  check("empty board", (await board(C)).length === 0);

  // submit
  let r = await (await post("/api/score", { challenge: C, name: "David", seconds: 180 })).json();
  check("first score accepted", r.improved === true && r.best === 180);

  await post("/api/score", { challenge: C, name: "Sam", seconds: 140 });
  await post("/api/score", { challenge: C, name: "Ray", seconds: 220 });
  let b = await board(C);
  check("ranked fastest first", b[0].name === "Sam" && b[0].rank === 1 && b[2].name === "Ray", JSON.stringify(b.map(x => x.name)));

  // the core requirement: same name keeps only the better time
  r = await (await post("/api/score", { challenge: C, name: "David", seconds: 90 })).json();
  b = await board(C);
  check("better time replaces old", r.improved === true && b.filter(s => s.name === "David").length === 1);
  check("improved time is the one kept", b.find(s => s.name === "David").seconds === 90);
  check("improving moved him to first", b[0].name === "David");

  r = await (await post("/api/score", { challenge: C, name: "David", seconds: 400 })).json();
  b = await board(C);
  check("worse time rejected", r.improved === false && b.find(s => s.name === "David").seconds === 90);

  r = await (await post("/api/score", { challenge: C, name: "  dAvId  ", seconds: 60 })).json();
  b = await board(C);
  check("name match ignores case and spacing", b.filter(s => s.name.toLowerCase() === "david").length === 1);
  check("name keeps latest capitalisation", b.find(s => s.seconds === 60).name === "dAvId");

  // validation
  check("rejects unknown challenge", (await post("/api/score", { challenge: "nope", name: "x", seconds: 60 })).status === 400);
  check("rejects blank name", (await post("/api/score", { challenge: C, name: "   ", seconds: 60 })).status === 400);
  check("rejects absurd time", (await post("/api/score", { challenge: C, name: "x", seconds: 0.2 })).status === 400);
  check("rejects non-numeric time", (await post("/api/score", { challenge: C, name: "x", seconds: "fast" })).status === 400);
  r = await (await post("/api/score", { challenge: C, name: "A".repeat(80), seconds: 99 })).json();
  check("long names truncated", (await board(C)).some(s => s.name.length === 20));
  r = await (await post("/api/score", { challenge: C, name: "Bob\u0007\u0000", seconds: 95 })).json();
  check("control characters stripped", (await board(C)).some(s => s.name === "Bob"));

  // boards are separate
  await post("/api/score", { challenge: "chw-dp", name: "David", seconds: 30 });
  check("challenges have separate boards", (await board("chw-dp")).length === 1 && (await board(C)).length > 1);

  // admin
  const target = (await board(C)).find(s => s.name === "Sam");
  check("edit refused without PIN", (await send("PATCH", `/api/score/${target.id}`, { name: "Samuel" })).status === 403);
  check("edit refused with wrong PIN", (await send("PATCH", `/api/score/${target.id}`, { name: "Samuel" }, "00000000")).status === 403);
  check("PIN check endpoint rejects bad PIN", (await post("/api/admin/check", {}, "12345678")).status === 403);
  check("PIN check endpoint accepts good PIN", (await post("/api/admin/check", {}, PIN)).ok);

  await send("PATCH", `/api/score/${target.id}`, { name: "Samuel" }, PIN);
  check("admin renamed entry", (await board(C)).some(s => s.name === "Samuel"));

  // renaming onto an existing name merges rather than duplicating
  const ray = (await board(C)).find(s => s.name === "Ray");
  await send("PATCH", `/api/score/${ray.id}`, { name: "Samuel" }, PIN);
  b = await board(C);
  check("rename onto existing name merges", b.filter(s => s.name.toLowerCase() === "samuel").length === 1);
  check("merge keeps the better time", b.find(s => s.name === "Samuel").seconds === 140);

  const doomed = (await board(C)).find(s => s.name === "Samuel");
  check("delete refused without PIN", (await send("DELETE", `/api/score/${doomed.id}`)).status === 403);
  await send("DELETE", `/api/score/${doomed.id}`, null, PIN);
  check("admin deleted entry", !(await board(C)).some(s => s.id === doomed.id));
  check("delete of missing row is 404", (await send("DELETE", `/api/score/does-not-exist`, null, PIN)).status === 404);

  // persistence across restart
  const before = await board(C);
  proc.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 400));
  const proc2 = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, ADMIN_PIN: PIN }, stdio: "ignore",
  });
  await ready();
  const after = await board(C);
  check("scores survive a restart", JSON.stringify(before) === JSON.stringify(after));
  proc2.kill("SIGTERM");

  console.log(out.join("\n"));
  const failed = out.filter(s => s.startsWith("FAIL")).length;
  console.log(`\n${out.length - failed}/${out.length} passed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error("test harness error:", err);
  proc.kill("SIGTERM");
  process.exit(1);
}

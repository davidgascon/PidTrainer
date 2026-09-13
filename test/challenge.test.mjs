/**
 * Challenge + leaderboard flow, end to end: real API server, real component
 * rendered in jsdom, fetch pointed at the server.
 *   npm run test:challenge
 */
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "looplab-ch-"));
const PIN = "22136969";
const PORT = 3458;
const base = `http://127.0.0.1:${PORT}`;
const api = spawn(process.execPath, ["server/index.js"], {
  env: { ...process.env, PORT: String(PORT), DATA_DIR: DIR, ADMIN_PIN: PIN }, stdio: "ignore",
});
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
  await new Promise(r => setTimeout(r, 100));
}

// seed a board so the leaderboard has rows to render
await fetch(base + "/api/score", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ challenge: "duct-static", name: "Sam", seconds: 212 }) });
await fetch(base + "/api/score", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ challenge: "duct-static", name: "David", seconds: 305 }) });

const built = await esbuild.build({ entryPoints: ["src/main.jsx"], bundle: true, format: "iife",
  platform: "browser", write: false, logLevel: "silent",
  loader: { ".css": "empty", ".woff": "empty", ".woff2": "empty" },
  define: { "process.env.NODE_ENV": '"development"' } });

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { pretendToBeVisual: true, url: base + "/", runScripts: "dangerously" });
const w = dom.window;
w.eval(`window.__probs=[];console.error=function(){window.__probs.push(Array.from(arguments).join(' ').slice(0,300));};`);
// jsdom has no fetch inside the realm; hand it the host one, rooted at the server
w.fetch = (u, o) => fetch(String(u).startsWith("http") ? u : base + u, o);
const sc = w.document.createElement("script");
sc.textContent = built.outputFiles[0].text;
w.document.body.appendChild(sc);

const root = w.document.getElementById("root");
const wait = ms => new Promise(r => setTimeout(r, ms));
const txt = () => root.textContent;
const has = t => txt().includes(t);
const btns = () => [...root.querySelectorAll("button")];
const find = t => btns().find(b => b.textContent.trim() === t);
const findIn = t => btns().find(b => b.textContent.includes(t));
const click = async (el, ms = 350) => { if (!el) return false; el.dispatchEvent(new w.MouseEvent("click", { bubbles: true })); await wait(ms); return true; };
const typeIn = async (el, val) => {
  if (!el) { out.push("FAIL  input not found for value " + val); return false; }
  const setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, "value").set;
  setter.call(el, val);
  el.dispatchEvent(new w.Event("input", { bubbles: true }));
  await wait(150);
  return true;
};
const out = []; const check = (n, ok, x = "") => out.push(`${ok ? "pass" : "FAIL"}  ${n}${ok ? "" : "  <- " + x}`);

await wait(900);
check("trainer loads with nav", has("Train") && has("Challenges"));

await click(find("Challenges"), 700);
check("leaderboard view opens", has("LEADERBOARD"));
check("existing scores render", has("Sam") && has("3:32"), txt().slice(0, 200));
check("fastest is ranked first", txt().indexOf("Sam") < txt().indexOf("David"));
check("original challenges listed", has("Duct static hunting") && has("Pump differential") && has("Box airflow") && has("Domestic hot water"));
check("new challenges listed", has("Supply fan trips") && has("Reheat valve chatter") && has("Building pressure"));

await click(find("Run this challenge"), 800);
// A run is settle + five disturbances, so the counter reads "of 6".
// Match the pattern rather than the number so the next change to
// CHAL_EVENTS doesn't break this again.
check("challenge starts", /\bof [1-9]\d*\b/.test(txt()) && has("Challenge started"));
check("clock locked to 1x", !find("60×") && !find("20×") && !!find("1×"));
check("manual event buttons hidden", !find("New setpoint") && !find("Throw a disturbance"));
check("loop picker hidden", !find("Change loop"));

// admin: click a time, wrong PIN then right PIN, rename, delete
await click(find("Challenges"), 700);
const row = (nm) => btns().find(b => /^\d/.test(b.textContent.trim()) && b.textContent.includes(nm) && b.textContent.includes(":"));
const samRow = row("Sam");
check("leaderboard rows are clickable", !!samRow, btns().map(b=>b.textContent.trim()).slice(0,12).join(" | "));
await click(samRow, 400);
check("clicking an entry asks for the PIN", has("admin PIN"), txt().slice(0,160));
let pinbox = root.querySelector("#pinbox");
await typeIn(pinbox, "00000000");
await click(find("Unlock"), 500);
check("wrong PIN rejected", has("not accepted"));
pinbox = root.querySelector("#pinbox");
await typeIn(pinbox, PIN);
await click(find("Unlock"), 500);
check("correct PIN unlocks editing", !!find("Save name") && !!find("Delete entry"));

const nameInput = [...root.querySelectorAll("input")].find(i => i.value === "Sam");
await typeIn(nameInput, "Samuel");
await click(find("Save name"), 600);
check("rename persisted", has("Samuel") && !has(">Sam<"));
const server1 = await (await fetch(base + "/api/board?challenge=duct-static")).json();
check("rename reached the server", server1.scores.some(s => s.name === "Samuel"));

await click(row("Samuel"), 400);
if (!find("Delete entry")) { await typeIn(root.querySelector("#pinbox"), PIN); await click(find("Unlock"), 500); }
await click(find("Delete entry"), 600);
const server2 = await (await fetch(base + "/api/board?challenge=duct-static")).json();
check("delete reached the server", !server2.scores.some(s => s.name === "Samuel"));
check("board re-rendered after delete", !has("Samuel"));

console.log(out.join("\n"));
console.log("\nconsole errors:", w.__probs.length ? w.__probs.slice(0, 3) : "none");
const failed = out.filter(s => s.startsWith("FAIL")).length;
console.log(`\n${out.length - failed}/${out.length} passed`);
api.kill("SIGTERM");
process.exit(failed ? 1 : 0);

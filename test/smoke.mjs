/**
 * Headless render + interaction test.
 *
 * A successful build proves the code parses. It does not prove the app runs.
 * This mounts the real component in jsdom and clicks through it, which is how
 * the StrictMode crash in the flavour toggle was caught before it shipped.
 *
 *   npm test
 */
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

// Bundle in memory so the test is a single self-contained command
const built = await esbuild.build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  format: "iife",
  platform: "browser",
  write: false,
  logLevel: "silent",
  loader: { ".css": "empty", ".woff": "empty", ".woff2": "empty" },
  define: { "process.env.NODE_ENV": '"development"' },
});
const bundle = built.outputFiles[0].text;

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { pretendToBeVisual: true, url: "http://localhost/", runScripts: "dangerously" });
const w = dom.window;
w.eval(`window.__probs=[];console.error=function(){window.__probs.push(Array.from(arguments).join(' ').slice(0,300));};`);
w.addEventListener("error", (e) => w.__probs.push("uncaught: " + (e.error?.stack || e.message)));
const sc = w.document.createElement("script");
sc.textContent = bundle;
w.document.body.appendChild(sc);

const wait = ms => new Promise(r => setTimeout(r, ms));
const root = w.document.getElementById('root');
// scope reads to the app, never document.body — the inline script text is in there
const txt = () => root.textContent.replace(/button:focus-visible[\s\S]*?}/g, '');
const has = t => txt().includes(t);
const btns = () => [...root.querySelectorAll('button')];
const find = t => btns().find(b => b.textContent.trim() === t);
const findIn = t => btns().find(b => b.textContent.includes(t));
const click = async (el, ms = 250) => { if (!el) return false; el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); await wait(ms); return true; };
const closeAny = async () => { for (const t of ["I'll tune it myself", 'Close', 'Back to the loop', 'Keep working']) if (find(t)) return click(find(t), 150); };
const out = []; const check = (n, ok) => out.push(`${ok ? 'pass' : 'FAIL'}  ${n}`);

await wait(600);
check('app mounts', root.children.length > 0 && has('discharge air'));
await click(find('60×'), 100); await wait(6000);

await click(find('Analyze this loop'));
check('analyze reports evidence', has('Average error') && has('Effective gain'));
// How far the starting fault has developed depends on frame pacing, so the
// analyzer may or may not have a change to offer yet. Either is a valid
// verdict; what must hold is that the modal renders and dismisses cleanly.
const applyBtn = find('Apply this change');
check('analyze reaches a verdict', !!applyBtn || has('Loop looks healthy') || has('cycling') || has('Hunting'));
await click(applyBtn || find("I'll tune it myself") || find('Close'), 400);
check('modal closes', !has('Loop analysis'));

await click(find('New setpoint'));
check('setpoint event logged', has('Setpoint moved'));
await click(find('Throw a disturbance'), 300);

let opened = 0;
for (const tag of ['AHU-9','VAV-22','AHU-5','ZN-14','HW-1','CH-1','DHW','SF-VFD','REL-FAN','P-VFD','VAV-08','TEST BENCH','AHU-3 / CLG-V']) {
  await closeAny();
  if (!has('Pick a loop to work on')) await click(find('Change loop'), 150);
  if (await click(findIn(tag), 200) && has(tag.split(' /')[0])) opened++;
}
check(`all 13 scenarios open (${opened})`, opened === 13);

if (!has('Pick a loop to work on')) await click(find('Change loop'), 150);
await click(findIn('REL-FAN'), 250);
await click(find('Siemens'), 250);
check('siemens shows Gain/Tn/coefficient', has('Tn') && has('Error coefficient') && !has('Proportional band'));
check('coefficient defaults to 1', /Error coefficient[\s\S]{0,600}?1×/.test(txt()));
check('off-dial warning on building static', has('the dial allows'));
await click(find('Analyze this loop'), 250);
check('siemens advice mentions the coefficient path', has('Effective gain'));
await closeAny();
await click(find('Generic'), 250);
check('flavour switch back works', has('Proportional band') && !has('Error coefficient'));

await click(find('Change loop'), 150);
await click(findIn('random service call'), 400);
check('blind call starts', has('Fault unknown') && has('recoveries verified'));
check('process details withheld', has('not documented'));
await click(find('Sign off on this loop'), 400);
check('debrief reveals fault', has('What was actually wrong') && has('The loop you were on'));
await closeAny();

const dots = btns().filter(b => b.textContent.trim() === '?');
check(`help dots present (${dots.length})`, dots.length >= 4);
await click(dots[0], 250);
check('help shows cliff notes', has('Cliff notes'));
const before = txt().length;
await click(find('Read more'), 250);
check('read more expands', txt().length > before + 300 && !find('Read more'));
await click(find('Back to the loop'), 200);
check('help closes', !has('Cliff notes'));

console.log(out.join("\n"));
console.log("\nconsole errors:", w.__probs.length ? w.__probs.slice(0, 3) : "none");

const failed = out.filter((s) => s.startsWith("FAIL")).length;
console.log(`\n${out.length - failed}/${out.length} passed`);
if (failed || w.__probs.length) process.exit(1);
process.exit(0);

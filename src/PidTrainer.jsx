import React, { useState, useRef, useEffect, useCallback } from "react";

/* ============================================================
   LOOP LAB — HVAC PID tuning trainer
   Multi-process: air temp, water temp, pressure, airflow
   ============================================================ */

const C = {
  chassis: "#C3CBCE",
  chassisDark: "#9BA6AB",
  bezel: "#232A2D",
  bezelLight: "#394347",
  paper: "#FBEADF",
  gridFine: "#EDBFA3",
  gridBold: "#D08A5C",
  ink: "#1C2A31",
  chw: "#1B6E9C",
  hw: "#B4342A",
  valve: "#2E7D5B",
  amber: "#D9911A",
  fault: "#A8342A",
  ok: "#2E7D5B",
  label: "#4A585F",
};

const FONT_D = "'Barlow Semi Condensed', 'Arial Narrow', 'Helvetica Neue', sans-serif";
const FONT_B = "'Inter', system-ui, -apple-system, sans-serif";

const DT = 0.05;
const CTRL = 1.0;   // controller scan interval, seconds
// Seconds inside the band before a recovery counts. A minute means nothing
// on a loop with a five-minute time constant, so this scales with the process.
const holdOf = (l) => clamp(Math.round(2 * (l.p.tau1 + l.p.dead) / 10) * 10, 60, 600);
const DB = 0.75;    // actuator deadband, percent

// Controller input filter. Longer dead time and noisier signals both
// justify more smoothing; too much of it becomes dead time itself.
const filtOf = (p) => Math.min(12, Math.max(3, p.dead * 0.4));

/* ============================================================
   SCENARIOS
   k        process gain, PV units per % output
   base     where PV sits with the output at 0%
   tau1/2   two lags in series, seconds
   dead     transport delay, seconds
   stroke   seconds for the final element to travel 0-100%
   ============================================================ */

const L = [
  /* ---------- AIR TEMPERATURE ---------- */
  {
    id: "ahu-hunt", group: "Air temperature", tag: "AHU-3 / CLG-V",
    name: "The coil that won't sit still",
    brief: "Occupants under this air handler complain the room swings warm then cold. The valve is never at rest. Find out why, then settle it.",
    p: { k: -0.35, base: 78, tau1: 35, tau2: 12, dead: 10, noise: 0.04, stroke: 90 },
    io: { unit: "°F", dec: 1, pv: "discharge air", out: "chilled water valve", outShort: "valve", color: C.chw },
    sp: { init: 55, range: [52, 60], steps: [1, 2, 3, 5], band: 0.5 },
    ctrl: { pb: [0.5, 30, 0.5], ti: [10, 1800, 10], td: [0, 90, 1] },
    start: { pb: 4.5, ti: 60, td: 0 },
    typical: "15–30 °F band, 40–120 s reset",
    speed: 6, sample: 0.5, spans: [180, 600, 1800],
    events: [
      { text: "Outside air damper swung open — mixed air is climbing", d: 9 },
      { text: "Economizer went to minimum position", d: -5 },
      { text: "Return air temperature rose as the space loaded up", d: 4 },
    ],
  },
  {
    id: "ahu-dead", group: "Air temperature", tag: "AHU-9 / CLG-V",
    name: "Sensor a long way downstream",
    brief: "The discharge sensor sits forty feet past the coil in a long duct run. Gains that work everywhere else will tear this loop apart. Respect the delay.",
    p: { k: -0.35, base: 78, tau1: 30, tau2: 12, dead: 32, noise: 0.04, stroke: 120 },
    io: { unit: "°F", dec: 1, pv: "discharge air", out: "chilled water valve", outShort: "valve", color: C.chw },
    sp: { init: 55, range: [52, 60], steps: [1, 2, 3], band: 0.5 },
    ctrl: { pb: [1, 60, 0.5], ti: [10, 1800, 10], td: [0, 90, 1] },
    start: { pb: 7.5, ti: 40, td: 0 },
    typical: "20–40 °F band, 100–250 s reset — dead time forces both wider and slower",
    speed: 6, sample: 0.5, spans: [300, 900, 1800],
    events: [
      { text: "Outside air damper swung open — mixed air is climbing", d: 9 },
      { text: "Supply fan stepped up, more air across the coil", d: 3 },
    ],
  },
  {
    id: "vav-rh", group: "Air temperature", tag: "VAV-22 / RH-V",
    name: "Actuator chatter",
    brief: "Maintenance has replaced this reheat actuator twice in a year. The temperature trend looks acceptable. Watch the valve, not just the temperature.",
    p: { k: 0.55, base: 55, tau1: 25, tau2: 8, dead: 6, noise: 0.9, stroke: 60 },
    io: { unit: "°F", dec: 1, pv: "leaving air", out: "hot water reheat valve", outShort: "valve", color: C.hw },
    sp: { init: 88, range: [72, 95], steps: [2, 4, 7], band: 0.8 },
    ctrl: { pb: [1, 60, 0.5], ti: [10, 1800, 10], td: [0, 90, 1] },
    start: { pb: 30, ti: 40, td: 20 },
    typical: "22–45 °F band, 40–120 s reset, no rate action",
    speed: 6, sample: 0.5, spans: [180, 600, 1800],
    events: [
      { text: "Primary air temperature dropped — AHU reset the discharge", d: -4 },
      { text: "Box went to minimum flow, less air to heat", d: 6 },
    ],
  },
  {
    id: "preheat", group: "Air temperature", tag: "AHU-5 / PRE-HT",
    name: "Same settings, different coil",
    brief: "These are the exact numbers that work fine on the cooling coil downstairs. This preheat coil is enormous and it's 20°F outside. Watch what happens when the process gain changes and the controller doesn't.",
    p: { k: 0.75, base: 20, tau1: 30, tau2: 10, dead: 12, noise: 0.06, stroke: 120 },
    io: { unit: "°F", dec: 1, pv: "preheat leaving air", out: "hot water valve", outShort: "valve", color: C.hw },
    sp: { init: 55, range: [45, 68], steps: [2, 3, 6], band: 1.0 },
    ctrl: { pb: [1, 60, 0.5], ti: [10, 1800, 10], td: [0, 90, 1] },
    start: { pb: 22, ti: 40, td: 0 },
    typical: "30–60 °F band, 60–180 s reset — a strong coil needs a wide band to stay calm",
    speed: 6, sample: 0.5, spans: [180, 600, 1800],
    events: [
      { text: "Outside air temperature dropped with the wind", d: -12 },
      { text: "Sun came out on the intake louver", d: 7 },
    ],
  },
  {
    id: "space", group: "Air temperature", tag: "ZN-14 / SPACE-T",
    name: "Don't tune a room like a duct",
    brief: "Somebody copied the discharge air settings into the space temperature loop. A room has thermal mass measured in hours, not seconds.",
    p: { k: -0.12, base: 76, tau1: 300, tau2: 90, dead: 45, noise: 0.08, stroke: 90 },
    io: { unit: "°F", dec: 1, pv: "space temperature", out: "cooling demand", outShort: "demand", color: C.chw },
    sp: { init: 72, range: [68, 75], steps: [1, 2, 3], band: 0.5 },
    ctrl: { pb: [0.5, 25, 0.5], ti: [30, 3600, 30], td: [0, 180, 5] },
    start: { pb: 3, ti: 40, td: 0 },
    typical: "5–10 °F band, 200–500 s reset — everything slows down",
    speed: 20, sample: 2, spans: [1800, 3600, 7200],
    events: [
      { text: "Conference room filled up — twenty people just walked in", d: 5 },
      { text: "Afternoon sun hit the west glass", d: 4 },
      { text: "Space emptied out for lunch", d: -3 },
    ],
  },

  /* ---------- WATER TEMPERATURE ---------- */
  {
    id: "hws", group: "Water temperature", tag: "HW-1 / MIX-V",
    name: "Hot water supply swings",
    brief: "The boiler plant holds fine, but the mixing valve downstream of it cycles all day. Long pipe run, long delay before the sensor sees anything.",
    p: { k: 0.9, base: 90, tau1: 60, tau2: 25, dead: 40, noise: 0.15, stroke: 150 },
    io: { unit: "°F", dec: 1, pv: "hot water supply", out: "mixing valve", outShort: "valve", color: C.hw },
    sp: { init: 140, range: [115, 168], steps: [4, 8, 15], band: 2.0 },
    ctrl: { pb: [2, 150, 1], ti: [20, 2400, 10], td: [0, 180, 5] },
    start: { pb: 16, ti: 100, td: 0 },
    typical: "55–110 °F band, 100–250 s reset",
    speed: 6, sample: 1, spans: [600, 1800, 3600],
    events: [
      { text: "Zone valves opened across the building — return water dropped", d: -14 },
      { text: "Morning warm-up ended, load fell off", d: 9 },
      { text: "Second boiler staged on", d: 6 },
    ],
  },
  {
    id: "chws", group: "Water temperature", tag: "CH-1 / CAP",
    name: "Chiller that takes its time",
    brief: "Leaving chilled water drifts for twenty minutes after a load change and the plant never quite catches up. Nothing is unstable here — it's just far too polite.",
    p: { k: -0.24, base: 58, tau1: 180, tau2: 60, dead: 60, noise: 0.1, stroke: 200 },
    io: { unit: "°F", dec: 1, pv: "leaving chilled water", out: "chiller capacity", outShort: "capacity", color: C.chw },
    sp: { init: 45, range: [42, 52], steps: [1, 2, 4], band: 0.7 },
    ctrl: { pb: [1, 90, 0.5], ti: [30, 3600, 30], td: [0, 180, 5] },
    start: { pb: 75, ti: 1800, td: 0 },
    typical: "12–25 °F band, 200–500 s reset",
    speed: 20, sample: 2, spans: [1800, 3600, 7200],
    events: [
      { text: "Building load spiked — return water came back warm", d: 6 },
      { text: "Half the air handlers went to unoccupied", d: -5 },
    ],
  },
  {
    id: "dhw", group: "Water temperature", tag: "DHW / TMP-V",
    name: "Fast process, still needs restraint",
    brief: "Domestic hot water through a mixing valve. The process responds in seconds, so aggressive settings feel safe — until an overshoot here is a scalding complaint.",
    p: { k: 1.1, base: 55, tau1: 8, tau2: 3, dead: 5, noise: 0.2, stroke: 30 },
    io: { unit: "°F", dec: 1, pv: "blended water", out: "tempering valve", outShort: "valve", color: C.hw },
    sp: { init: 120, range: [105, 135], steps: [3, 5, 10], band: 2.0 },
    ctrl: { pb: [2, 120, 0.5], ti: [5, 900, 5], td: [0, 60, 1] },
    start: { pb: 12, ti: 30, td: 0 },
    typical: "40–85 °F band, 30–90 s reset",
    speed: 1, sample: 0.5, spans: [120, 300, 900],
    events: [
      { text: "Someone opened a shower — cold water inlet surged", d: -8 },
      { text: "Draw stopped, line went stagnant", d: 6 },
    ],
  },

  /* ---------- PRESSURE ---------- */
  {
    id: "static", group: "Pressure", tag: "AHU-3 / SF-VFD",
    name: "Duct static hunting the fan",
    brief: "The supply fan speed is surging up and down every few seconds and you can hear it in the ductwork. Pressure loops are fast — the settings that suit a coil will make a fan unstable.",
    p: { k: 0.03, base: 0, tau1: 4, tau2: 1.5, dead: 1.5, noise: 0.035, stroke: 40 },
    io: { unit: "in. w.c.", dec: 2, pv: "duct static pressure", out: "supply fan speed", outShort: "fan", color: C.valve },
    sp: { init: 1.5, range: [0.8, 2.5], steps: [0.2, 0.4, 0.7], band: 0.1 },
    ctrl: { pb: [0.1, 6, 0.05], ti: [5, 600, 5], td: [0, 30, 1] },
    start: { pb: 0.5, ti: 15, td: 0 },
    typical: "1.4–2.8 in. w.c. band, 15–45 s reset, never any rate action",
    speed: 1, sample: 0.5, spans: [120, 300, 900],
    events: [
      { text: "Half the VAV boxes closed at once", d: 0.45 },
      { text: "Boxes opened wide on a cooling call", d: -0.4 },
      { text: "Filters are loading up", d: 0.25 },
    ],
  },
  {
    id: "bldg", group: "Pressure", tag: "BLDG / REL-FAN",
    name: "Building pressure on a windy day",
    brief: "Front doors are hard to pull open and the relief fan hunts constantly. This loop works in thousandths of an inch, and the signal is mostly noise.",
    p: { k: -0.0025, base: 0.15, tau1: 5, tau2: 2, dead: 2, noise: 0.006, stroke: 45 },
    io: { unit: "in. w.c.", dec: 3, pv: "building static", out: "relief fan speed", outShort: "fan", color: C.valve },
    sp: { init: 0.05, range: [-0.02, 0.12], steps: [0.01, 0.02, 0.04], band: 0.01 },
    ctrl: { pb: [0.005, 0.3, 0.005], ti: [10, 900, 5], td: [0, 30, 1] },
    start: { pb: 0.045, ti: 15, td: 0 },
    typical: "0.12–0.25 in. w.c. band, 10–40 s reset — filter the signal, then go gentle",
    speed: 1, sample: 0.5, spans: [180, 600, 1800],
    events: [
      { text: "Loading dock door rolled open", d: -0.07 },
      { text: "Gust hit the windward face", d: 0.05 },
      { text: "Outside air damper opened for economizer", d: 0.06 },
    ],
  },
  {
    id: "dp", group: "Pressure", tag: "CHW / P-VFD",
    name: "Differential pressure surge",
    brief: "Chilled water pump speed oscillates whenever the load shifts, and the noisy DP transmitter isn't helping. Distinguish real cycling from a jittery sensor.",
    p: { k: 0.28, base: 2, tau1: 3, tau2: 1, dead: 1, noise: 0.35, stroke: 35 },
    io: { unit: "psid", dec: 1, pv: "differential pressure", out: "pump speed", outShort: "pump", color: C.chw },
    sp: { init: 12, range: [8, 20], steps: [1, 2, 4], band: 0.8 },
    ctrl: { pb: [1, 60, 0.5], ti: [5, 600, 5], td: [0, 30, 1] },
    start: { pb: 5.5, ti: 10, td: 0 },
    typical: "18–38 psid band, 5–20 s reset",
    speed: 1, sample: 0.5, spans: [120, 300, 900],
    events: [
      { text: "Coil valves stroked closed across a wing", d: 4 },
      { text: "Big load came on and valves opened", d: -3.5 },
    ],
  },

  /* ---------- AIRFLOW ---------- */
  {
    id: "cfm", group: "Airflow", tag: "VAV-08 / DMPR",
    name: "Box flow versus a slow damper",
    brief: "The airflow reading is noisy and the damper actuator takes a minute and a half to stroke. Two very different speeds in one loop.",
    p: { k: 14, base: 80, tau1: 4, tau2: 1.5, dead: 2, noise: 25, stroke: 90 },
    io: { unit: "cfm", dec: 0, pv: "box airflow", out: "damper position", outShort: "damper", color: C.valve },
    sp: { init: 800, range: [300, 1400], steps: [100, 250, 500], band: 40 },
    ctrl: { pb: [50, 2000, 25], ti: [5, 900, 5], td: [0, 60, 1] },
    start: { pb: 300, ti: 20, td: 0 },
    typical: "1000–1800 cfm band, 15–45 s reset — match the reset to the actuator, not the sensor",
    speed: 1, sample: 0.5, spans: [180, 600, 1800],
    events: [
      { text: "Other boxes closed and duct static rose", d: 130 },
      { text: "Supply fan slowed on a static reset", d: -110 },
    ],
  },

  /* ---------- BENCH ---------- */
  {
    id: "free", group: "Bench", tag: "TEST BENCH",
    name: "Free bench",
    brief: "No fault, no clock. Move the setpoint, throw a load at it, and watch what each adjustment actually does.",
    p: { k: -0.35, base: 78, tau1: 35, tau2: 12, dead: 10, noise: 0.05, stroke: 90 },
    io: { unit: "°F", dec: 1, pv: "discharge air", out: "chilled water valve", outShort: "valve", color: C.chw },
    sp: { init: 55, range: [50, 62], steps: [1, 2, 3, 5, 7], band: 0.5 },
    ctrl: { pb: [1, 60, 0.5], ti: [10, 1800, 10], td: [0, 90, 1] },
    start: { pb: 30, ti: 60, td: 0 },
    typical: "20–40 °F band, 40–120 s reset",
    speed: 6, sample: 0.5, spans: [180, 600, 1800],
    events: [
      { text: "Outside air damper swung open", d: 9 },
      { text: "Load dropped off", d: -6 },
    ],
  },
];

/* ============================================================
   REFERENCE TUNES — what a competent tech would leave behind.
   Used to build faults and to grade a blind call afterwards.
   ============================================================ */

/* pb/ti derived by grid search over each model; ts is the settling time
   that tune achieves, averaged over setpoint steps and load changes. */
const REF = {
  "ahu-hunt": { pb: 22, ti: 40, td: 0, ts: 130 },
  "ahu-dead": { pb: 30, ti: 110, td: 0, ts: 255 },
  "vav-rh": { pb: 32.5, ti: 40, td: 0, ts: 130 },
  preheat: { pb: 43.5, ti: 80, td: 0, ts: 110 },
  space: { pb: 6.5, ti: 240, td: 0, ts: 505 },
  hws: { pb: 80, ti: 120, td: 0, ts: 275 },
  chws: { pb: 18, ti: 240, td: 0, ts: 470 },
  dhw: { pb: 60, ti: 40, td: 0, ts: 45 },
  static: { pb: 1.95, ti: 15, td: 0, ts: 20 },
  bldg: { pb: 0.18, ti: 10, td: 0, ts: 35 },
  dp: { pb: 26.5, ti: 5, td: 0, ts: 15 },
  cfm: { pb: 1475, ti: 15, td: 0, ts: 30 },
  free: { pb: 30, ti: 40, td: 0, ts: 125 },
};

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];

/* Each fault takes the reference tune and breaks it a specific way.
   `reveal` is only shown in the debrief after sign-off. */
const FAULTS = [
  {
    id: "gain",
    reveal: "Proportional band far too narrow",
    why: "Someone chased a slow response by tightening the band and kept going. The loop ended up hunting on gain.",
    make: (r) => ({ pb: r.pb / rnd(3, 6), ti: r.ti * rnd(0.8, 1.3), td: 0 }),
  },
  {
    id: "reset",
    reveal: "Integral time far too short",
    why: "Reset was cranked up to kill an offset. It killed the offset and started a slow rolling cycle instead.",
    make: (r) => ({ pb: r.pb * rnd(0.9, 1.3), ti: r.ti / rnd(4, 9), td: 0 }),
  },
  {
    id: "noreset",
    reveal: "Reset switched off, leaving droop",
    why: "The loop was hunting, so the last tech pushed integral time to its maximum to stop it. That stopped the cycling and left the loop parked off setpoint permanently.",
    make: (r, c) => ({ pb: r.pb * rnd(1.2, 2.2), ti: c.ti[1], td: 0 }),
  },
  {
    id: "sluggish",
    reveal: "Band too wide and reset too slow",
    why: "Tuned defensively after a callback. Nothing is unstable, but the loop can't keep up with a load change.",
    make: (r) => ({ pb: r.pb * rnd(3, 6), ti: r.ti * rnd(3, 7), td: 0 }),
  },
  {
    id: "rate",
    reveal: "Derivative added to a noisy signal",
    why: "Rate action was added to damp overshoot. On a noisy transmitter it just makes the actuator chase noise.",
    // only worth injecting where the signal is noisy enough for it to bite
    applies: (b) => b.p.noise / b.sp.band > 0.3,
    make: (r) => ({ pb: r.pb / rnd(1.2, 2), ti: r.ti * rnd(0.8, 1.2), td: r.ti / rnd(2, 4) }),
  },
  {
    id: "copied",
    reveal: "Settings copied from a different piece of equipment",
    why: "These numbers came off another unit with completely different dynamics. Both gain and reset are wrong for this process.",
    make: (r) => ({ pb: r.pb / rnd(2.5, 5), ti: r.ti / rnd(3, 7), td: 0 }),
  },
];

const COMPLAINTS = [
  "Occupant complaint: space is uncomfortable and it isn't getting better.",
  "Callback from last week. The previous tech adjusted something and left.",
  "Flagged on the morning rounds. Trend looks wrong to the operator.",
  "Recurring alarm on this loop. Nobody wrote down what was done last time.",
  "Work order says only: check controls, loop not right.",
  "Facilities manager wants this one signed off before the end of the day.",
];

/* Build a one-off service call: real process, scrambled dynamics,
   randomized setpoint, one injected fault, nothing labelled. */
function makeCall() {
  const base = pick(L.filter((x) => x.id !== "free"));
  const r = REF[base.id];
  const fault = pick(FAULTS.filter((f) => !f.applies || f.applies(base)));
  const j = (v, f) => v * rnd(1 - f, 1 + f);

  const p = {
    ...base.p,
    k: base.p.k * j(1, 0.25),
    tau1: Math.max(1, j(base.p.tau1, 0.3)),
    tau2: Math.max(0.5, j(base.p.tau2, 0.3)),
    dead: Math.max(0.5, +j(base.p.dead, 0.4).toFixed(1)),
    stroke: Math.max(10, Math.round(j(base.p.stroke, 0.35))),
    noise: base.p.noise * j(1, 0.35),
  };

  const [lo, hi] = base.sp.range;
  const spInit = snap(rnd(lo + (hi - lo) * 0.15, hi - (hi - lo) * 0.15), [lo, hi, base.sp.steps[0] / 2]);

  const raw = fault.make(r, base.ctrl);
  const gains = {
    pb: snap(raw.pb, base.ctrl.pb),
    ti: snap(raw.ti, base.ctrl.ti),
    td: snap(raw.td, base.ctrl.td),
  };

  return {
    ...base,
    p,
    sp: { ...base.sp, init: spInit },
    start: gains,
    blind: true,
    truth: { fault, ref: r, name: base.name, brief: base.brief },
    complaint: pick(COMPLAINTS),
    order: `WO-${Math.floor(rnd(1000, 9999))}`,
  };
}


/* ============================================================
   CHALLENGE MODE

   A challenge has to be identical for everyone or the leaderboard means
   nothing, so these are fixed: fixed loop, fixed starting gains, fixed
   setpoint step, fixed disturbance. No scrambling, no randomness.

   Each challenge has its own board. Times are not comparable across loops
   — a duct static loop settles in seconds, a chiller takes minutes — so
   ranking them together would be meaningless.

   Only fast loops are used. The clock runs at 1x in challenge mode, so a
   slow thermal loop would mean a twenty minute sitting.
   ============================================================ */

/* Revision, as XX.XX. Bump the right pair for anything small — a tweaked
   scenario, copy changes, a bug fix. Bump the left pair and reset the right
   to 00 when something changes how the thing is used: a new mode, a change
   to how runs are scored, a controller flavour. Edit it here and nowhere
   else; the footer reads from this. */
const VERSION = "02.06";

// How many disturbances a challenge run throws after the first settle.
// Date a record was set. Short, and no time of day — nobody cares that a
// duct static PB was set at 14:07.
const shortDate = (ms) => {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });
  } catch { return "—"; }
};

const STATES = [
  { label: "in band", color: C.ok },
  { label: "off setpoint", color: C.amber },
  { label: "out of control", color: C.fault },
];

const CHAL_EVENTS = 5;

// Recoveries needed to sign off a blind service call. Lower than a challenge
// run: this is "prove it isn't luck", not a timed contest.
const BLIND_PASSES = 2;

const CHALLENGES = [
  {
    id: "duct-static",
    title: "Duct static hunting",
    blurb: "Supply fan surging on a duct static loop. Settle it, then hold it through a load change.",
    loop: "static",
    start: { pb: 0.5, ti: 15, td: 0 },
    step: 0.4,        // setpoint move, in engineering units
    events: [0, 1, 2, 1, 0],   // indices into the loop's event list
  },
  {
    id: "chw-dp",
    title: "Pump differential pressure",
    blurb: "Chilled water pump speed oscillating on a noisy DP transmitter.",
    loop: "dp",
    start: { pb: 5.5, ti: 10, td: 0 },
    step: 2,
    events: [0, 1, 0, 1, 0],
  },
  {
    id: "vav-flow",
    title: "Box airflow, slow damper",
    blurb: "Noisy flow signal, ninety second damper. Two very different speeds in one loop.",
    loop: "cfm",
    start: { pb: 300, ti: 20, td: 0 },
    step: 250,
    events: [0, 1, 0, 1, 0],
  },
  {
    id: "dhw-temp",
    title: "Domestic hot water",
    blurb: "Tempering valve swinging on a fast process. Overshoot here is a scalding complaint.",
    loop: "dhw",
    start: { pb: 12, ti: 30, td: 0 },
    step: 5,
    events: [0, 1, 0, 1, 0],
  },

  /* ---- six more, all fast loops so a run stays under a few minutes ---- */

  {
    id: "static-filters",
    title: "Duct static, loaded filters",
    blurb: "Fan surging, and the filters are near the end of their life. Milder than the headline one, but five load swings in a row.",
    loop: "static",
    start: { pb: 1, ti: 45, td: 0 },
    step: 0.5,
    events: [2, 0, 1, 2, 0],
  },
  {
    id: "static-trip",
    title: "Supply fan trips",
    blurb: "Detuned after a callback, and partway through the run the supply fan drops out. Static goes to zero, the controller winds up against a wall, and then the fan restarts. Getting it back is the challenge.",
    loop: "static",
    start: { pb: 10, ti: 300, td: 0 },
    step: 0.6,
    events: [
      0,
      { trip: 40, text: "SUPPLY FAN TRIPPED — static at zero, the VFD command is doing nothing" },
      1,
      { trip: 25, text: "FAN TRIPPED AGAIN — starter is dropping out under load" },
      0,
    ],
  },
  {
    id: "dp-noreset",
    title: "Pump DP, reset switched off",
    blurb: "Rock steady and permanently off setpoint. The last tech killed the hunting by turning integral action off entirely.",
    loop: "dp",
    start: { pb: 22, ti: 600, td: 0 },
    step: 3,
    events: [1, 0, 1, 0, 1],
  },
  {
    id: "bldg-static",
    title: "Building pressure, windy day",
    blurb: "Thousandths of an inch of water, a signal that is mostly noise, and doors that people keep opening.",
    loop: "bldg",
    start: { pb: 0.045, ti: 15, td: 0 },
    step: 0.03,
    events: [0, 1, 2, 0, 1],
  },
  {
    id: "vav-chatter",
    title: "Reheat valve chatter",
    blurb: "Rate action on a noisy leaving air sensor. The temperature trend looks fine and the valve never stops moving.",
    loop: "vav-rh",
    start: { pb: 30, ti: 40, td: 20 },
    step: 4,
    events: [0, 1, 0, 1, 0],
  },
  {
    id: "dhw-copied",
    title: "Hot water, settings off another unit",
    blurb: "These numbers came off a coil loop with completely different dynamics. Gain and Tn are both wrong for this valve.",
    loop: "dhw",
    start: { pb: 4, ti: 300, td: 0 },
    step: 8,
    events: [0, 1, 0, 1, 0],
  },
];

const API = {
  async board(challenge) {
    const r = await fetch(`/api/board?challenge=${encodeURIComponent(challenge)}`);
    if (!r.ok) throw new Error("could not load the leaderboard");
    return (await r.json()).scores;
  },
  async submit(challenge, name, seconds) {
    const r = await fetch("/api/score", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challenge, name, seconds }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "could not submit");
    return body;
  },
  async checkPin(pin) {
    const r = await fetch("/api/admin/check", {
      method: "POST", headers: { "content-type": "application/json", "x-admin-pin": pin },
      body: "{}",
    });
    return r.ok;
  },
  async edit(id, pin, patch) {
    const r = await fetch(`/api/score/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-admin-pin": pin },
      body: JSON.stringify(patch),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "could not save");
    return body;
  },
  async remove(id, pin) {
    const r = await fetch(`/api/score/${id}`, {
      method: "DELETE", headers: { "x-admin-pin": pin },
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "could not delete");
    return body;
  },
};

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;

/* ============================================================
   HELP CONTENT
   ============================================================ */

const HELP = {
  pb: {
    title: "Proportional band",
    short:
      "How far the measurement has to stray from setpoint to drive the output from fully closed to fully open. A 4 °F band means 4 degrees of error swings the valve across its whole range. Wide band, gentle controller. Narrow band, aggressive controller.",
    more: [
      { h: "Why HVAC uses band instead of gain", p: "Band and gain are the same adjustment written two ways: gain in percent per unit equals 100 divided by the band. Controls people kept the band because it's in the units on the sensor — you can stand at the unit, look at a 3 °F band, and know that three degrees off setpoint drives the valve wide open." },
      { h: "What too narrow looks like", p: "A regular, repeating cycle with a short period, and an output that slams between its limits. The controller over-corrects, the correction arrives late because of dead time, and it has to over-correct the other way. This is hunting, and it wears out actuators fast." },
      { h: "What too wide looks like", p: "Sluggish, well-behaved response that never quite arrives. The output barely moves off its resting position. Wide band also leaves a bigger steady offset if there's no integral action to clean it up." },
      { h: "The offset it leaves behind", p: "Proportional action only produces an output when there is error. No error, no correction. So a proportional-only loop always parks slightly off setpoint — the error it needs to hold the valve where the load requires. That leftover is called droop, and integral action exists to remove it." },
      { h: "How to set it", p: "Start wide and safe, then halve it and watch one full response before halving again. Keep going until you see a clean overshoot with a second, smaller one after it, then back off one step. Set band first and get it stable before you touch reset." },
    ],
  },
  ti: {
    title: "Integral time (reset)",
    short:
      "How many seconds the controller takes to repeat the proportional correction on its own. It keeps nudging the output as long as any error remains, so it drives the offset out. Shorter is more aggressive. Very long values effectively switch it off.",
    more: [
      { h: "What it's actually doing", p: "Integral accumulates error over time and adds it to the output. As long as the measurement sits off setpoint, that accumulation grows and the output keeps moving. It only stops when error reaches zero — which is exactly why it eliminates droop." },
      { h: "Repeats per minute", p: "Some controllers ask for repeats per minute instead of seconds. They're reciprocals: 60 divided by the integral time in seconds gives repeats per minute. A 120-second reset is 0.5 repeats per minute. Same adjustment, inverted scale, so remember which way aggressive runs on the panel in front of you." },
      { h: "What too fast looks like", p: "A rolling cycle while the output uses only part of its range. Reset winds the output well past what the load needed, then has to unwind it. Be careful here: a cycle from too much gain and a cycle from too fast a reset look very similar on a trend, and the periods overlap enough that you cannot reliably tell them apart just by looking. The way you find out is to change one and watch — widen the band first, since that is the more common cause, and only touch reset if the cycle survives." },
      { h: "Windup", p: "If the output is already at a limit and the error won't clear — a valve wide open on a design day — integral keeps accumulating against a wall. When the load finally breaks, the controller has to unwind all of it before the output comes off the stop, and the loop overshoots badly. Anti-windup stops the accumulation while the output is saturated. This trainer has it enabled." },
      { h: "How to set it", p: "Tie it to how fast the process responds, not to how fast you want results. A rough starting point is the process time constant. Longer dead time means slower reset, always." },
    ],
  },
  td: {
    title: "Derivative time (rate)",
    short:
      "Responds to how fast the measurement is moving, not how far off it is. In theory it anticipates and damps overshoot. In practice, most HVAC temperature and pressure loops should leave it at zero.",
    more: [
      { h: "Why zero is usually right", p: "Derivative amplifies noise. It acts on rate of change, and a jittery sensor reading looks like an enormous rate of change. The result is an output that twitches constantly while the measurement sits perfectly still. You will see it in actuator travel long before you see it on the temperature trend." },
      { h: "Derivative kick", p: "If rate action is taken on error rather than on the measurement, a setpoint change creates an instant, infinite rate of change and the output slams to a limit. Good controllers take derivative on the measurement instead, which avoids the kick. This trainer does." },
      { h: "When it earns its place", p: "Large thermal masses with long dead time and clean signals — big chilled water plants, heavy slab systems. If you use it, keep it small: under about an eighth of the integral time, and add it only after gain and reset are already settled." },
    ],
  },
  gain: {
    title: "Gain (K)",
    short:
      "How much output you get per unit of error. A gain of 5 means one degree off setpoint produces five percent of valve. It is the same adjustment as a proportional band, written the other way up: gain equals 100 divided by the band.",
    more: [
      { h: "Band and gain are reciprocals", p: "A 20 °F band and a gain of 5 %/°F are the same setting. Generic and textbook controllers usually ask for the band because it is in the units on the sensor. Siemens asks for the gain. Neither is more correct, but they run in opposite directions: a bigger band is gentler, a bigger gain is more aggressive. Get that backwards on a live loop and you will make things worse fast." },
      { h: "What the units really are", p: "Percent of output per unit of measurement. That matters because the number that suits a temperature loop in °F is nothing like the number that suits a pressure loop in inches of water or a flow loop in cfm. The same physical loop can need a gain of 0.07 or 550 depending only on what units the sensor reports in." },
      { h: "When the dial cannot reach", p: "A controller's gain range is fixed by the product. If the loop needs a gain outside that range — and pressure and flow loops routinely do — the dial alone will not get you there. That is what the error coefficient is for." },
      { h: "What too much looks like", p: "A regular cycle with a short period, and an output that slams between its limits. What too little looks like: a sluggish response that never quite arrives, and a bigger leftover offset if integral action is not cleaning it up." },
    ],
  },
  tn: {
    title: "Integral action time (Tn)",
    short:
      "The same adjustment as integral time or reset, in seconds: how long the controller takes to repeat the proportional correction on its own. It keeps nudging the output until the error is gone, which is what removes droop. Shorter is more aggressive. On Siemens controllers, Tn of 0 switches integral action off completely.",
    more: [
      { h: "What it is doing", p: "Integral accumulates error over time and adds it to the output. As long as the measurement sits off setpoint, that accumulation grows and the output keeps moving. It only stops when the error reaches zero — which is exactly why it eliminates the offset that proportional action leaves behind." },
      { h: "Tn of zero", p: "Zero does not mean instant. It means off. A controller with Tn at zero is proportional-only and will sit permanently off setpoint by whatever error the load requires. If you inherit a loop that is rock steady and always two degrees out, check Tn before you touch anything else." },
      { h: "What too fast looks like", p: "A rolling cycle while the output uses only part of its range. Be careful here: a cycle from too much gain and a cycle from too short a Tn look very similar on a trend, and the periods overlap enough that you cannot reliably tell them apart by looking. Change one and watch — back the gain off first, since that is the more common cause." },
      { h: "Windup", p: "If the output is already at a limit and the error will not clear, integral keeps accumulating against a wall. When the load finally breaks, the controller has to unwind all of it before the output comes off the stop, and the loop overshoots badly. Anti-windup stops the accumulation while the output is saturated. This trainer has it enabled." },
    ],
  },
  ec: {
    title: "Error coefficient",
    short:
      "Multiplies the setpoint and the measured value separately, before either one reaches the PID block, so the block works in scaled units rather than engineering units. Effective gain is the gain dial times this coefficient. It is a workaround for a gain range that cannot reach what your loop needs.",
    more: [
      { h: "Why it exists", p: "A controller's gain range is fixed, but the numbers a loop needs depend entirely on the units of the measurement. A building static loop working in hundredths of an inch of water can need an effective gain of several hundred percent per inch. A box airflow loop working in cfm can need less than a tenth of a percent per cfm. Neither number is reachable on a dial that stops at 50 and starts at 0.1. Scaling the error moves the whole problem into a range the dial can express." },
      { h: "Scaling both inputs is the same as scaling the error", p: "The block subtracts one from the other, and multiplying both by the same number multiplies the difference by that number: four times the setpoint minus four times the measurement is four times the error. So scaling the two inputs separately, scaling the error, and multiplying the gain all produce an identical loop. There is no extra magic and no hidden dynamics. The reason to reach for the coefficient rather than the gain is that the gain has a floor and a ceiling and the coefficient effectively does not." },
      { h: "Where it stops being identical", p: "As long as the block only uses the difference, the three are interchangeable. It diverges the moment anything works on an absolute value instead: a neutral zone or deadband set in engineering units, an output limit tied to the measurement, a startup ramp, or a graphic reading the block's setpoint. Those all see the scaled number, not the real one." },
      { h: "It scales integral action too", p: "The integral term is built from the same scaled error, so it moves with the coefficient automatically. Tn keeps its meaning in seconds and does not need adjusting when you change the coefficient. That is what makes this workaround clean rather than a bodge." },
      { h: "What to watch out for", p: "The scaled error is not the real error. Anything else that reads that value — a graphic, an alarm limit, a trend log, the next technician — is now looking at a number that is not in engineering units. Label it. Also keep an eye on the scaled value's own limits: multiply a large error by a large coefficient and you can run into the block's internal range before the loop ever saturates the valve." },
      { h: "The cleaner alternative", p: "Where the controller allows it, normalising the measurement to a percentage of a sensible span does the same job and leaves everything downstream readable. The coefficient is what you use when you cannot do that, which in practice is often." },
    ],
  },
  proc: {
    title: "Dead time and lag",
    short:
      "Dead time is the delay before the measurement responds at all. Lag is how long it takes to finish responding once it starts. Dead time is what limits how aggressive you can tune — every second of it is a second the controller is acting on stale information.",
    more: [
      { h: "Why dead time is the hard one", p: "Lag just slows things down; you can tune around it. Dead time means the controller is correcting based on a measurement that describes the past. Double the dead time and you roughly have to double the band and slow the reset to match, or the loop will cycle." },
      { h: "Where it hides", p: "Transport delay in a long duct or pipe run, a sensor in a poor location, a slow actuator stroke, and the controller's own scan interval all add to it. A 90-second valve stroke is dead time in every sense that matters to the loop." },
      { h: "What to do about it", p: "Tune conservatively, or reduce it: move the sensor closer, speed up the actuator, shorten the scan. Reducing dead time buys more performance than any amount of adjustment on the controller." },
    ],
  },
  band: {
    title: "Settling band",
    short:
      "The tolerance the loop has to hold to be called settled — and staying inside it for the full hold time is what stops the clock. Getting there fast is easy. Getting there fast and staying is the actual skill.",
    more: [
      { h: "Why the hold time matters", p: "A loop can pass through setpoint on its way to a big overshoot. Requiring a sustained hold inside the band rules that out and rewards a response that arrives and stops. The required hold scales with the process — a minute proves something on a duct static loop and nothing at all on a room." },
      { h: "What gets measured with it", p: "Actuator travel, in percent per hour, runs alongside the clock. A fast settle bought with a valve that never stops moving is not a good tune — it's a maintenance ticket in six months. Under about 600 %/hr is easy living for an actuator." },
    ],
  },
};


/* ============================================================
   CONTROLLER FLAVOURS

   Generic: proportional band in engineering units, integral time,
   derivative time — the textbook ISA form.

   Siemens: gain and integral action time Tn only, no rate action,
   and a fixed gain range that doesn't care what units your loop
   works in. That last part is why the error coefficient exists.

   The coefficient multiplies the error before it reaches the block,
   so effective gain = K × coefficient. Mathematically it is just a
   gain multiplier; practically it is how you reach a gain the
   controller itself cannot express.
   ============================================================ */

const EC_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1,
                  2, 5, 10, 20, 50, 100, 200, 500, 1000];

// A real controller's ranges are fixed by the product, not by the loop.
const SIEMENS = { k: [0.1, 50, 0.1], tn: [0, 3000, 5] };

// Where the Siemens flavour starts: gain 4, Tn 2 minutes, coefficient 1.
// A sane field default to adapt from, not a tune for any particular loop.
const SIEMENS_DEFAULT = { k: 4, tn: 120, ec: 1 };

// Resolved gains the simulation actually runs on.
// ti of 0 means integral action is switched off.
function resolve(g, l, mode) {
  const ec = g.ec == null ? 1 : g.ec;
  // k  = the number on the dial, applied to the scaled error
  // kp = effective gain in engineering units (k x ec), for display and analysis
  if (mode === "siemens") {
    const k = Math.max(1e-9, g.k);
    return { k, kp: k * ec, ti: g.tn > 0 ? g.tn : 0, td: 0, ec };
  }
  const k = 100 / Math.max(1e-6, g.pb);
  return { k, kp: k * ec, ti: g.ti >= l.ctrl.ti[1] ? 0 : g.ti, td: g.td, ec };
}

// Smallest sane coefficient that puts a required gain on the dial.
// Only consulted when the dial alone can't get there.
const pickEc = (kp) => {
  if (kp >= SIEMENS.k[0] && kp <= SIEMENS.k[1]) return 1;
  const want = clamp(Math.pow(10, Math.round(Math.log10(kp / 5))), 0.001, 1000);
  return EC_STEPS.reduce((b, v) =>
    Math.abs(Math.log10(v / want)) < Math.abs(Math.log10(b / want)) ? v : b, 1);
};

// Switch flavour without changing how the loop behaves.
function convert(g, l, from, to) {
  if (from === to) return g;
  const R = resolve(g, l, from);
  if (to === "siemens") return { ...g, ...SIEMENS_DEFAULT };
  return {
    ...g, ec: 1,
    pb: snap(100 / Math.max(1e-6, R.kp), l.ctrl.pb),
    ti: R.ti > 0 ? snap(R.ti, l.ctrl.ti) : l.ctrl.ti[1],
    td: 0,
  };
}

function applyChange(g, l, mode, ch) {
  const n = { ...g };
  if (ch.gainMul != null) {
    if (mode === "siemens") {
      const target = g.k * ch.gainMul;
      if (target < SIEMENS.k[0] || target > SIEMENS.k[1]) {
        const kp = resolve(g, l, mode).kp * ch.gainMul;
        n.ec = pickEc(kp);
        n.k = snap(kp / n.ec, SIEMENS.k);
      } else n.k = snap(target, SIEMENS.k);
    } else n.pb = snap(g.pb / ch.gainMul, l.ctrl.pb);
  }
  if (ch.tiMul != null) {
    if (mode === "siemens") n.tn = snap(Math.max(SIEMENS.tn[2], (g.tn || 60) * ch.tiMul), SIEMENS.tn);
    else n.ti = snap(g.ti * ch.tiMul, l.ctrl.ti);
  }
  if (ch.ti != null) {
    if (mode === "siemens") n.tn = snap(ch.ti, SIEMENS.tn);
    else n.ti = snap(ch.ti, l.ctrl.ti);
  }
  if (ch.td != null && mode !== "siemens") n.td = snap(ch.td, l.ctrl.td);
  return n;
}

/* wording helpers so advice reads correctly in either flavour */
const tiName = (mode) => (mode === "siemens" ? "Tn" : "integral time");
const tiNow = (g, l, mode) => {
  const R = resolve(g, l, mode);
  return R.ti > 0 ? `${Math.round(R.ti)} s` : "off";
};
const gainNow = (g, l, mode) =>
  mode === "siemens"
    ? `${round(g.k)}${g.ec !== 1 ? ` with the ${g.ec}× coefficient (${round(resolve(g, l, mode).kp)} %/${l.io.unit})` : ""}`
    : `${round(g.pb)} ${l.io.unit}`;
const advGain = (g, l, mode, mul) => {
  const verb = mul < 1 ? "Reduce" : "Raise";
  if (mode !== "siemens") {
    return `${mul < 1 ? "Widen" : "Narrow"} the proportional band from ${round(g.pb)} to about ${round(snap(g.pb / mul, l.ctrl.pb))} ${l.io.unit}`;
  }
  const target = g.k * mul;
  if (target >= SIEMENS.k[0] && target <= SIEMENS.k[1]) {
    return `${verb} the gain from ${round(g.k)} to about ${round(snap(target, SIEMENS.k))}`;
  }
  const kp = resolve(g, l, mode).kp * mul;
  const ec = pickEc(kp);
  return `${verb} the effective gain to about ${round(kp)} %/${l.io.unit}. That is off the end of the ${SIEMENS.k[0]}–${SIEMENS.k[1]} gain dial, so move the error coefficient to ${ec}× and set the gain to ${round(snap(kp / ec, SIEMENS.k))}`;
};
const advTi = (g, l, mode, secs) =>
  `${resolve(g, l, mode).ti > 0 && secs < resolve(g, l, mode).ti ? "Speed up" : "Slow"} ${tiName(mode)} to about ${Math.round(secs)} s`;

/* ============================================================
   SIMULATION
   ============================================================ */

function makeSim(l) {
  const u0 = clamp((l.sp.init - l.p.base) / l.p.k, 0, 100);
  return {
    t: 0, x1: l.sp.init, x2: l.sp.init, pv: l.sp.init, pvf: l.sp.init, sp: l.sp.init,
    base: l.p.base, baseTarget: l.p.base,
    cmd: u0, out: u0, integral: 0, prevPV: l.sp.init, dFilt: 0,
    ctrlAcc: 0, sampAcc: 0,
    delay: new Array(Math.max(1, Math.round(l.p.dead / DT))).fill(u0),
    di: 0, hist: [], travel: 0, rev: 0, lastDir: 0,
    stepAt: null, inBand: 0, verified: null, event: null, passes: 0, worst: 0,
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function step(s, l, g, dt, mode) {
  const p = l.p;
  const sense = -Math.sign(p.k); // +1 when output must rise as PV rises
  const filt = filtOf(p);
  const R = resolve(g, l, mode || "generic");

  s.ctrlAcc += dt;
  if (s.ctrlAcc >= CTRL) {
    const T = s.ctrlAcc;
    s.ctrlAcc = 0;

    // input filter — every real controller has one, and without it
    // the output chases sensor noise all day
    const fa = T / (T + filt);
    s.pvf += fa * (s.pv - s.pvf);

    // ABT applies the coefficient to the setpoint and the measurement
    // separately, before either reaches the block. The block then works
    // entirely in scaled units.
    const spBlock = R.ec * s.sp;
    const pvBlock = R.ec * s.pvf;
    s.spBlock = spBlock;
    s.pvBlock = pvBlock;

    const kp = R.k;
    const err = sense * (pvBlock - spBlock);
    const P = kp * err;

    const dpv = (sense * (pvBlock - R.ec * s.prevPV)) / T;
    const a = T / (T + Math.max(0.5, R.td / 8));
    s.dFilt += a * (dpv - s.dFilt);
    const D = R.td > 0 ? kp * R.td * s.dFilt : 0;
    s.prevPV = s.pvf;

    const off = !(R.ti > 0);
    let out = P + D + (off ? 0 : (kp / R.ti) * s.integral);
    if (!off) {
      const sat = (out > 100 && err > 0) || (out < 0 && err < 0);
      if (!sat) {
        s.integral += err * T;
        out = P + D + (kp / R.ti) * s.integral;
      }
    }
    s.cmd = clamp(out, 0, 100);
  }

  const rate = 100 / p.stroke;
  const gap = s.cmd - s.out;
  // actuators do not respond to hairline commands
  const mv = Math.abs(gap) < DB ? 0 : clamp(gap, -rate * dt, rate * dt);
  if (Math.abs(mv) > 1e-9) {
    const d = Math.sign(mv);
    if (d !== s.lastDir && s.lastDir !== 0) s.rev += 1;
    s.lastDir = d;
    s.travel += Math.abs(mv);
  }
  s.out += mv;

  s.delay[s.di] = s.out;
  s.di = (s.di + 1) % s.delay.length;
  const ud = s.delay[s.di];

  s.base += (s.baseTarget - s.base) * (dt / 25);

  // While tripped the final element has no authority at all — the fan is off,
  // the pump is stopped — so the process falls back to its passive value.
  const tripped = s.tripUntil != null && s.t < s.tripUntil;
  const target = s.base + (tripped ? 0 : p.k) * ud;
  s.x1 += ((target - s.x1) / p.tau1) * dt;
  s.x2 += ((s.x1 - s.x2) / p.tau2) * dt;
  s.pv = s.x2 + (Math.random() - 0.5) * p.noise;
  s.t += dt;

  if (s.stepAt != null && s.verified == null) {
    s.worst = Math.max(s.worst, Math.abs(s.pv - s.sp));
    if (Math.abs(s.pv - s.sp) <= l.sp.band) {
      s.inBand += dt;
      const hold = holdOf(l);
      if (s.inBand >= hold) { s.verified = s.t - s.stepAt - hold; s.passes += 1; }
    } else s.inBand = 0;
  }

  s.sampAcc += dt;
  if (s.sampAcc >= l.sample) {
    s.sampAcc = 0;
    s.hist.push({ t: s.t, pv: s.pv, sp: s.sp, u: s.out });
    const keep = l.spans[l.spans.length - 1];
    while (s.hist.length && s.hist[0].t < s.t - keep) s.hist.shift();
  }
}

/* ---------- randomized events ---------- */

function rollStep(s, l) {
  const [lo, hi] = l.sp.range;
  const opts = [];
  for (const m of l.sp.steps) {
    if (s.sp + m <= hi + 1e-9) opts.push(m);
    if (s.sp - m >= lo - 1e-9) opts.push(-m);
  }
  if (!opts.length) return null;
  const jitter = 0.85 + Math.random() * 0.3;
  const raw = opts[Math.floor(Math.random() * opts.length)] * jitter;
  const next = clamp(s.sp + raw, lo, hi);
  const from = s.sp;
  s.sp = next;
  s.stepAt = s.t; s.inBand = 0; s.verified = null; s.travel = 0; s.worst = 0;
  const d = next - from;
  s.event = {
    t: s.t,
    text: `Setpoint moved ${fmt(from, l)} → ${fmt(next, l)} ${l.io.unit} (${d > 0 ? "+" : ""}${fmt(d, l)})`,
  };
  return s.event;
}

// Same disturbance every time, for challenge runs.
// A hard failure rather than a load change: the equipment stops, the
// measurement collapses to whatever the process does with no help at all,
// and the controller winds up against a wall until it restarts.
function rollTrip(s, l, secs, text) {
  s.tripUntil = s.t + secs;
  s.stepAt = s.t; s.inBand = 0; s.verified = null; s.worst = 0;
  s.event = { t: s.t, text };
  return s.event;
}

function rollEventFixed(s, l, idx) {
  const e = l.events[idx % l.events.length];
  s.baseTarget = s.base + e.d;
  s.stepAt = s.t; s.inBand = 0; s.verified = null; s.worst = 0;
  s.event = { t: s.t, text: e.text };
  return s.event;
}

function rollEvent(s, l) {
  const e = l.events[Math.floor(Math.random() * l.events.length)];
  const jitter = 0.7 + Math.random() * 0.6;
  s.baseTarget = s.base + e.d * jitter;
  s.stepAt = s.t; s.inBand = 0; s.verified = null; s.travel = 0; s.worst = 0;
  s.event = { t: s.t, text: e.text };
  return s.event;
}

const fmt = (v, l) => v.toFixed(l.io.dec);

/* ============================================================
   ANALYSIS
   ============================================================ */

function movingAvg(a, n) {
  const o = [];
  for (let i = 0; i < a.length; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { s += a[j]; c++; }
    o.push(s / c);
  }
  return o;
}

function extrema(t, v, prom) {
  const e = [];
  let dir = 0;
  for (let i = 1; i < v.length; i++) {
    const d = Math.sign(v[i] - v[i - 1]);
    if (d === 0) continue;
    if (dir === 0) { dir = d; continue; }
    if (d !== dir) {
      const ref = e.length ? e[e.length - 1].v : v[0];
      if (Math.abs(v[i - 1] - ref) >= prom) e.push({ t: t[i - 1], v: v[i - 1] });
      dir = d;
    }
  }
  return e;
}

function analyze(s, l, g, mode) {
  mode = mode || "generic";
  const R = resolve(g, l, mode);
  const p = l.p, U = l.io.unit, band = l.sp.band;
  const lookback = Math.max(240, 8 * (p.dead + p.tau1));
  const win = s.hist.filter((h) => h.t >= s.t - lookback);
  if (win.length < 40) {
    return { code: "warm", head: "Not enough trend yet", detail: "Let the loop run for a few minutes, or step the setpoint, then analyze again." };
  }

  const ts = win.map((h) => h.t);
  const sm = movingAvg(win.map((h) => h.pv), 5);
  const ex = extrema(ts, sm, Math.max(band * 0.25, p.noise * 1.5));

  const recent = win.slice(-Math.round(Math.max(60, 3 * p.tau1) / l.sample));
  const mean = recent.reduce((a, h) => a + (h.pv - h.sp), 0) / recent.length;
  const uSpan = Math.max(...win.map((h) => h.u)) - Math.min(...win.map((h) => h.u));
  const travel = (s.travel / Math.max(1, s.t)) * 3600;
  const revs = (s.rev / Math.max(1, s.t)) * 3600;

  const facts = [];
  let period = null, amp = null, decay = null;
  if (ex.length >= 4) {
    const e = ex.slice(-4);
    period = e[3].t - e[1].t;
    amp = Math.abs(e[3].v - e[2].v) / 2;
    decay = amp / Math.max(1e-6, Math.abs(e[1].v - e[0].v) / 2);
    facts.push(["Cycle period", `${period.toFixed(0)} s`]);
    facts.push(["Swing", `±${fmt(amp, l)} ${U}`]);
    facts.push(["Cycle to cycle", decay > 1.05 ? "growing" : decay > 0.85 ? "not decaying" : `decaying ${decay.toFixed(2)}`]);
  }
  facts.push(["Average error", `${mean >= 0 ? "+" : ""}${fmt(mean, l)} ${U}`]);
  facts.push(["Output range used", `${uSpan.toFixed(0)} %`]);
  facts.push([`${cap(l.io.outShort)} travel`, `${travel.toFixed(0)} %/hr`]);
  facts.push(["Direction reversals", `${revs.toFixed(0)} /hr`]);
  facts.push(["Effective gain", `${round(R.kp)} %/${U}`]);
  facts.push(["Dead time in loop", `${p.dead} s`]);

  const osc = period != null && amp > Math.max(band * 0.3, p.noise) && decay > 0.8;
  const softer = advGain(g, l, mode, 0.5);
  const harder = advGain(g, l, mode, 2);

  if (R.td > 0 && revs > 250 && travel > 400 && (!osc || amp < band * 0.6)) {
    return {
      code: "chatter", head: "Rate action is amplifying sensor noise", facts,
      detail: `The ${l.io.pv} is reasonably steady, but the ${l.io.outShort} reverses direction ${revs.toFixed(0)} times an hour and racks up ${travel.toFixed(0)} %/hr of travel. Derivative acts on rate of change, and a noisy signal looks like a very fast rate of change. The loop is chasing noise and the actuator pays for it.`,
      fix: `Take rate action out — set derivative to 0 s. Almost no HVAC temperature or pressure loop needs it. Siemens controllers usually don't even offer it, which tells you something.`,
      apply: { td: 0 },
    };
  }

  if (osc) {
    const growing = decay > 1.05;
    const saturating = uSpan > 85;

    // Output slamming both limits is unambiguous evidence of excess gain.
    // Short of that, a gain-driven cycle and an integral-driven one look
    // almost identical on a passive trend — so don't pretend otherwise.
    if (saturating) {
      return {
        code: "hunt", head: growing ? "Unstable — the swing is growing" : "Hunting, with the output against its limits", facts,
        detail: `A regular ${period.toFixed(0)} s cycle, and the ${l.io.outShort} is slamming ${uSpan.toFixed(0)}% of its range. It drives to one limit, waits for the measurement to catch up, then drives to the other. That is too much gain — no ambiguity about it.`,
        fix: `${softer} and watch a full cycle before you judge it.`,
        apply: { gainMul: 0.5 },
      };
    }

    // Still cycling while the output barely moves: gain is not what's
    // driving this, so reset is the thing to change.
    // Integral can only be driving this if it's fast relative to the cycle.
    // Once Tn is longer than the cycle period, doubling it again is pointless.
    if (uSpan < 40 && R.ti > 0 && R.ti < period * 1.5 && R.ti * 2 < 3000) {
      return {
        code: "reset", head: "Cycling on a nearly stationary output", facts,
        detail: `A ${period.toFixed(0)} s cycle while the ${l.io.outShort} uses only ${uSpan.toFixed(0)}% of its range. With the output moving that little, gain isn't what's driving this. Integral action is winding the output past what the load needed and then unwinding it.`,
        fix: `Slow it down: raise ${tiName(mode)} from ${tiNow(g, l, mode)} to about ${Math.round(R.ti * 2)} s, and leave the gain where it is.`,
        apply: { tiMul: 2 },
      };
    }

    // If the gain adjustment is already at the end of its travel, stop
    // recommending a change that cannot be made.
    const gainPinned = mode === "siemens"
      ? g.k <= SIEMENS.k[0] && (g.ec == null || g.ec <= EC_STEPS[0])
      : g.pb >= l.ctrl.pb[1];
    if (gainPinned && R.ti > 0 && R.ti * 2 < 3000) {
      return {
        code: "reset", head: "Cycling with the gain already at its limit", facts,
        detail: `A ${period.toFixed(0)} s cycle, and ${mode === "siemens" ? "the gain is already as low as it goes" : `the band is already at the widest this loop allows, ${round(l.ctrl.pb[1])} ${U}`}. Gain has nothing left to give, so what's left driving this is integral action.`,
        fix: `Raise ${tiName(mode)} from ${tiNow(g, l, mode)} to about ${Math.round(R.ti * 2)} s. On a process this slow, ${tiName(mode)} usually needs to be far longer than instinct suggests.`,
        apply: { tiMul: 2 },
      };
    }

    return {
      code: "cycle", head: growing ? "Cycling, and the swing is growing" : "The loop is cycling", facts,
      detail: `A regular ${period.toFixed(0)} s cycle, swinging ±${fmt(amp, l)} ${U}, and it isn't decaying. Both too much gain and too fast an integral time produce a cycle that looks like this. On a trend alone you cannot reliably tell which one is driving it — the periods overlap. What you can do is change one thing at a time and watch what the cycle does.`,
      fix: `${softer} first — excess gain is the more common cause and the safer move. Watch at least one full cycle, around ${period.toFixed(0)} s, before deciding. If it still cycles, put the gain back and double ${tiName(mode)} from ${tiNow(g, l, mode)} instead.`,
      apply: { gainMul: 0.5 },
    };
  }

  // is the error still shrinking, or has it parked?
  const half = Math.floor(recent.length / 2);
  const e1 = recent.slice(0, half).reduce((a, h) => a + Math.abs(h.pv - h.sp), 0) / Math.max(1, half);
  const e2 = recent.slice(half).reduce((a, h) => a + Math.abs(h.pv - h.sp), 0) / Math.max(1, recent.length - half);
  const converging = e2 < e1 * 0.85;

  if (Math.abs(mean) > band * 0.8 && converging) {
    return {
      code: "slow", head: "Sluggish — it's getting there, slowly", facts,
      detail: `The ${l.io.pv} is still ${fmt(Math.abs(mean), l)} ${U} off setpoint and closing, but only just. The ${l.io.outShort} is using ${uSpan.toFixed(0)}% of its range. Nothing is unstable — the loop is simply too polite to keep up with a load change.`,
      fix: `${harder}, then bring ${tiName(mode)} down toward ${Math.round(Math.max(20, p.tau1 * 3))} s. Halve, watch one full response, halve again — back off a step at the first sign of a second overshoot.`,
      apply: { gainMul: 2 },
    };
  }

  if (Math.abs(mean) > band * 0.8) {
    const off = !(R.ti > 0);
    return {
      code: "offset", head: "Steady offset — it parks off setpoint", facts,
      detail: `The ${l.io.pv} is holding ${fmt(Math.abs(mean), l)} ${U} ${mean > 0 ? "above" : "below"} setpoint and not moving toward it. Proportional action needs an error to produce an output, so a proportional-only loop always parks on a leftover error. That's droop.${off ? (mode === "siemens" ? " Tn is at zero here, which switches integral action off entirely." : " Integral time is at its maximum here, which switches reset off entirely.") : ""}`,
      fix: `${advTi(g, l, mode, Math.max(20, p.tau1 * 3))}. Come down in steps and stop before it starts to cycle.`,
      apply: { ti: Math.max(20, p.tau1 * 3) },
    };
  }

  if (s.verified == null && s.stepAt != null && s.t - s.stepAt > 8 * (p.tau1 + p.dead)) {
    return {
      code: "slow", head: "Sluggish — stable, but it takes forever", facts,
      detail: `It has been ${Math.round(s.t - s.stepAt)} s since the setpoint moved and the loop still hasn't held inside ±${fmt(band, l)} ${U}. The ${l.io.outShort} is only using ${uSpan.toFixed(0)}% of its range. Nothing is unstable — it's just far too polite.`,
      fix: `${harder}, then bring ${tiName(mode)} toward ${Math.round(Math.max(20, p.tau1 * 3))} s. Halve, watch a full response, halve again — back off a step at the first sign of a second overshoot.`,
      apply: { gainMul: 2 },
    };
  }

  return {
    code: "good", head: "Loop looks healthy", facts,
    detail: `Holding within ${fmt(Math.abs(mean), l)} ${U} of setpoint with no sustained cycling, and the ${l.io.outShort} is moving ${travel.toFixed(0)} %/hr. Under about 600 %/hr is easy living for an actuator.`,
    fix: "Prove it before you leave: step the setpoint and confirm it recovers with at most one small overshoot, then throw a load change at it.",
  };
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const round = (v) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v.toFixed(3));
const snap = (v, [lo, hi, st]) => {
  const n = clamp(Math.round(v / st) * st, lo, hi);
  return +n.toFixed(Math.max(0, -Math.floor(Math.log10(st)) + 1)); // kill float crumbs
};

/* ---------- blind-mode sign-off ---------- */

function buildDebrief(l, g, s, hints, mode) {
  mode = mode || "generic";
  const R = resolve(g, l, mode);
  const d = analyze(s, l, g, mode);
  const travel = (s.travel / Math.max(1, s.t)) * 3600;
  const ref = l.truth.ref;
  const kpRef = 100 / ref.pb;
  const stable = d.code === "good";
  const enough = s.passes >= BLIND_PASSES;
  const gentle = travel < 900;
  const pass = stable && enough && gentle;

  const near = (a, b) => a / b >= 0.45 && a / b <= 2.2;
  const gainOk = near(R.kp, kpRef);
  const tiOk = R.ti > 0 && near(R.ti, ref.ti);

  const rows = [
    ["Recoveries verified", `${s.passes} of ${BLIND_PASSES}`],
    ["Last settling time", s.verified != null ? `${Math.round(s.verified)} s` : "not settled"],
    ["Worst deviation", `${fmt(s.worst, l)} ${l.io.unit}`],
    [`${cap(l.io.outShort)} travel`, `${travel.toFixed(0)} %/hr`],
    ["Hints used", `${hints}`],
    ["Reference settles in", `about ${ref.ts} s`],
    ["Your gain vs reference", `${round(R.kp)} vs ${round(kpRef)} %/${l.io.unit}`],
    [`Your ${tiName(mode)} vs reference`, `${R.ti > 0 ? Math.round(R.ti) + " s" : "off"} vs ${ref.ti} s`],
  ];

  let note;
  if (!enough) {
    note = `Sign-off needs two verified recoveries. Step the setpoint, let it hold inside the band for ${holdOf(l)} s, then throw a disturbance at it and let it settle again. One good response can be luck.`;
  } else if (!stable) {
    note = `The analyzer still reads this loop as: ${d.head.toLowerCase()}. ${d.fix || ""}`;
  } else if (!gentle) {
    note = `The measurement side is fine, but the ${l.io.outShort} is moving ${travel.toFixed(0)} %/hr. That's a mechanic replacing an actuator inside a year. Back the gain off a step, or take out any rate action, and re-verify.`;
  } else if (s.verified != null && s.verified > ref.ts * 2.2) {
    note = `Stable and inside the band, but it took ${Math.round(s.verified)} s where a good tune on this loop settles in about ${ref.ts} s. Nothing here is unsafe — it's just slow. Bring the gain up a step or speed up ${tiName(mode)}, and re-verify.`;
  } else if (gainOk && tiOk) {
    note = `Both numbers landed close to the reference, and you got there by reading the trend rather than being told. That's the whole exercise.${mode === "siemens" && R.ec !== 1 ? ` Worth noting you did it with a ${R.ec}× error coefficient — the gain dial alone could not have reached ${round(kpRef)} %/${l.io.unit} on this loop.` : ""}`;
  } else if (!gainOk && tiOk) {
    note = `Stable and settled, but your effective gain is ${R.kp > kpRef ? "higher" : "lower"} than the reference ${round(kpRef)} %/${l.io.unit}. ${R.kp < kpRef ? "You left performance on the table — there's room to push." : "It works, but you're closer to the edge of stability than you need to be."}`;
  } else if (gainOk && !tiOk) {
    note = `Gain is right. ${cap(tiName(mode))} ${R.ti === 0 ? "is switched off, so you're relying on a small offset staying small" : R.ti > ref.ti ? "is slower than it needs to be — recovery from a load change will drag" : "is faster than the reference, so watch for a slow roll under a bigger disturbance"}.`;
  } else {
    note = `It holds, but both numbers drifted from the reference (${round(kpRef)} %/${l.io.unit} effective gain, ${ref.ti} s). More than one combination can look stable in a quiet hour — the difference shows up under a load change.`;
  }

  return { pass, head: pass ? "Signed off" : enough ? "Not ready to sign off" : "Needs more proof", rows, note, truth: l.truth };
}

/* ============================================================
   CHART
   ============================================================ */

function niceStep(range) {
  const raw = range / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

function Chart({ hist, sp, span, l }) {
  const W = 620, H = 330, TOP = 216, BOT = 96, PL = 52, PR = 10, GAP = 18;
  if (!hist.length) return null;
  const now = hist[hist.length - 1].t;
  const t0 = Math.max(0, now - span);
  let vis = hist.filter((h) => h.t >= t0);
  if (vis.length > 700) { const n = Math.ceil(vis.length / 700); vis = vis.filter((_, i) => i % n === 0 || i === vis.length - 1); }
  if (vis.length < 2) return null;

  const pvs = vis.map((h) => h.pv);
  const pad = l.sp.band * 5;
  let lo = Math.min(sp - pad, ...pvs), hi = Math.max(sp + pad, ...pvs);
  const m = (hi - lo) * 0.08; lo -= m; hi += m;

  const X = (t) => PL + ((t - t0) / span) * (W - PL - PR);
  const Y = (v) => 12 + ((hi - v) / (hi - lo)) * (TOP - 24);
  const YU = (u) => TOP + GAP + 10 + ((100 - u) / 100) * (BOT - 20);
  const path = (acc) => vis.map((h, i) => `${i ? "L" : "M"}${X(h.t).toFixed(1)},${acc(h).toFixed(1)}`).join("");

  const st = niceStep(hi - lo);
  const ticks = [];
  for (let v = Math.ceil(lo / st) * st; v <= hi; v += st) ticks.push(v);
  const tst = span > 3000 ? 900 : span > 1200 ? 300 : span > 400 ? 120 : span > 150 ? 60 : 30;
  const tticks = [];
  for (let t = Math.ceil(t0 / tst) * tst; t <= now; t += tst) tticks.push(t);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", display: "block" }} role="img"
      aria-label={`${l.io.pv} and ${l.io.out} trend`}>
      <rect width={W} height={H} fill={C.paper} />
      {Array.from({ length: 40 }, (_, i) => PL + (i * (W - PL - PR)) / 39).map((x, i) => (
        <line key={"f" + i} x1={x} y1="6" x2={x} y2={H - 16} stroke={C.gridFine} strokeWidth="0.5" />
      ))}
      {Array.from({ length: 14 }, (_, i) => 6 + (i * (H - 22)) / 13).map((y, i) => (
        <line key={"h" + i} x1={PL} y1={y} x2={W - PR} y2={y} stroke={C.gridFine} strokeWidth="0.5" />
      ))}
      {ticks.map((v) => (
        <g key={"t" + v}>
          <line x1={PL} y1={Y(v)} x2={W - PR} y2={Y(v)} stroke={C.gridBold} strokeWidth="0.8" />
          <text x={PL - 6} y={Y(v) + 3.5} textAnchor="end" fontSize="10" fill={C.label} fontFamily={FONT_B}>
            {st < 1 ? v.toFixed(l.io.dec) : v.toFixed(0)}
          </text>
        </g>
      ))}
      {tticks.map((t) => (
        <g key={"x" + t}>
          <line x1={X(t)} y1="6" x2={X(t)} y2={H - 16} stroke={C.gridBold} strokeWidth="0.8" />
          <text x={X(t)} y={H - 4} textAnchor="middle" fontSize="9.5" fill={C.label} fontFamily={FONT_B}>
            {now - t < 90 ? `-${Math.round(now - t)}s` : `-${Math.round((now - t) / 60)}m`}
          </text>
        </g>
      ))}
      <rect x={PL} y={Y(sp + l.sp.band)} width={W - PL - PR}
        height={Math.abs(Y(sp - l.sp.band) - Y(sp + l.sp.band))} fill={C.chw} opacity="0.1" />
      <line x1={PL} y1={TOP + GAP / 2} x2={W - PR} y2={TOP + GAP / 2} stroke={C.gridBold} strokeWidth="1.4" />
      {[0, 50, 100].map((u) => (
        <text key={u} x={PL - 6} y={YU(u) + 3.5} textAnchor="end" fontSize="10" fill={C.label} fontFamily={FONT_B}>{u}</text>
      ))}
      <path d={path((h) => Y(h.sp))} fill="none" stroke={C.chw} strokeWidth="1.6" strokeDasharray="6 4" />
      <path d={path((h) => Y(h.pv))} fill="none" stroke={C.ink} strokeWidth="2" strokeLinejoin="round" />
      <path d={path((h) => YU(h.u))} fill="none" stroke={l.io.color} strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx={X(vis[vis.length - 1].t)} cy={Y(vis[vis.length - 1].pv)} r="3.2" fill={C.ink} />
      <circle cx={X(vis[vis.length - 1].t)} cy={YU(vis[vis.length - 1].u)} r="3" fill={l.io.color} />
      <text x={PL + 4} y={16} fontSize="10.5" fill={C.label} fontFamily={FONT_B}>{l.io.pv} · {l.io.unit}</text>
      <text x={PL + 4} y={TOP + GAP + 8} fontSize="10.5" fill={C.label} fontFamily={FONT_B}>{l.io.out} · %</text>
    </svg>
  );
}


// Typical values, expressed in whichever flavour is on screen.
function typicalFor(l, mode, g) {
  const r = REF[l.id];
  if (!r) return null;
  const kp = 100 / r.pb;
  const tail = l.typical && l.typical.includes("—") ? ` — ${l.typical.split("—")[1].trim()}` : "";
  const tn = `${Math.round(r.ti * 0.6)}–${Math.round(r.ti * 2)} s`;
  if (mode === "siemens") {
    const ec = g.ec || 1;
    return `gain ${round(kp * 0.7 / ec)}–${round(kp * 1.5 / ec)} at a ${ec}× coefficient, Tn ${tn}${tail}`;
  }
  return `${round(r.pb * 0.7)}–${round(r.pb * 1.5)} ${l.io.unit} band, ${tn} reset${tail}`;
}

/* ============================================================
   UI PARTS
   ============================================================ */

const btnSm = {
  width: 32, height: 32, borderRadius: 4, border: `1px solid ${C.bezelLight}`,
  background: C.chassis, color: C.ink, fontSize: 18, lineHeight: 1, cursor: "pointer", fontFamily: FONT_D,
};
const btn = (primary) => ({
  padding: "10px 14px", borderRadius: 4, cursor: "pointer",
  border: `1px solid ${primary ? C.bezel : C.bezelLight}`,
  background: primary ? C.bezel : "transparent",
  color: primary ? C.paper : C.ink,
  fontFamily: FONT_D, fontSize: 16, fontWeight: 600, letterSpacing: 0.3,
});

function HelpDot({ onClick, label }) {
  return (
    <button onClick={onClick} aria-label={`What is ${label}?`} title={`What is ${label}?`}
      style={{
        width: 19, height: 19, borderRadius: "50%", border: `1.5px solid ${C.chw}`,
        background: "transparent", color: C.chw, fontSize: 12, fontWeight: 700,
        fontFamily: FONT_B, lineHeight: 1, cursor: "pointer", padding: 0,
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        verticalAlign: "middle", marginLeft: 6, flexShrink: 0,
      }}>?</button>
  );
}

function Readout({ label, value, unit, color, big }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
      <span style={{ fontSize: 10.5, color: C.label }}>{label}</span>
      <span style={{ fontFamily: FONT_D, fontSize: big ? 34 : 23, lineHeight: 1, fontWeight: 600, color: color || C.ink, fontVariantNumeric: "tabular-nums" }}>
        {value}<span style={{ fontSize: big ? 13 : 10.5, fontWeight: 500, marginLeft: 3, color: C.label }}>{unit}</span>
      </span>
    </div>
  );
}

/* Editable readout. Tap the number and type it — the sliders are fine for
   exploring, but once you know you want 22.5 you want to just say so. */
function ValueField({ value, display, unit, onCommit, width = 68 }) {
  const [draft, setDraft] = useState(null);
  const editing = draft !== null;

  const commit = () => {
    const n = parseFloat(String(draft).replace(/[^0-9.eE+-]/g, ""));
    if (Number.isFinite(n)) onCommit(n);
    setDraft(null);
  };

  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", flexShrink: 0 }}>
      <input
        type="text"
        inputMode="decimal"
        value={editing ? draft : display}
        aria-label={`${unit ? unit + " " : ""}value, editable`}
        onFocus={(e) => { setDraft(String(value)); setTimeout(() => e.target.select(), 0); }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          if (e.key === "Escape") { setDraft(null); e.currentTarget.blur(); }
        }}
        style={{
          width, textAlign: "right", fontFamily: FONT_D, fontSize: 21, fontWeight: 600,
          color: C.ink, background: editing ? "#fff" : "transparent",
          border: "none", borderBottom: `1px dashed ${editing ? C.chw : C.bezelLight}`,
          borderRadius: 2, padding: "1px 3px", fontVariantNumeric: "tabular-nums",
        }}
      />
      {unit ? <span style={{ fontSize: 10.5, color: C.label, marginLeft: 2 }}>{unit}</span> : null}
    </span>
  );
}

function Knob({ label, hint, value, set, range, fmt: f, unit, help }) {
  const [lo, hi, st] = range;
  const nudge = (d) => set(snap(value + d * st, range));
  return (
    <div style={{ padding: "10px 0", borderTop: `1px solid ${C.chassisDark}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT_D, fontSize: 17, fontWeight: 600, letterSpacing: 0.2, display: "flex", alignItems: "center" }}>
            {label}<HelpDot onClick={help} label={label} />
          </div>
          <div style={{ fontSize: 11, color: C.label, lineHeight: 1.35 }}>{hint}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <button onClick={() => nudge(-1)} style={btnSm}>−</button>
          <ValueField value={value} display={f(value)} unit={unit}
            onCommit={(n) => set(snap(n, range))} />
          <button onClick={() => nudge(1)} style={btnSm}>+</button>
        </div>
      </div>
      <input type="range" min={lo} max={hi} step={st} value={value ?? lo} aria-label={label}
        onChange={(e) => set(parseFloat(e.target.value))}
        style={{ width: "100%", marginTop: 8, accentColor: C.chw }} />
    </div>
  );
}


function EcKnob({ value, set, help, l, g }) {
  const i = Math.max(0, EC_STEPS.indexOf(value ?? 1));
  const eff = round(g.k * value);
  return (
    <div style={{ padding: "10px 0", borderTop: `1px solid ${C.chassisDark}` }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT_D, fontSize: 17, fontWeight: 600, letterSpacing: 0.2, display: "flex", alignItems: "center" }}>
            Error coefficient<HelpDot onClick={help} label="the error coefficient" />
          </div>
          <div style={{ fontSize: 11, color: C.label, lineHeight: 1.35 }}>
            Setpoint and measurement are both multiplied by this before the block sees them. Gain × coefficient = {eff} %/{l.io.unit}.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
          <button onClick={() => set(EC_STEPS[Math.max(0, i - 1)])} style={btnSm}>−</button>
          <ValueField value={value} display={String(value)} unit="×"
            onCommit={(n) => {
              // snap a typed coefficient to the nearest preset, in log space
              const t = clamp(Math.abs(n) || 1, EC_STEPS[0], EC_STEPS[EC_STEPS.length - 1]);
              set(EC_STEPS.reduce((b, v) =>
                Math.abs(Math.log10(v / t)) < Math.abs(Math.log10(b / t)) ? v : b, EC_STEPS[0]));
            }} />
          <button onClick={() => set(EC_STEPS[Math.min(EC_STEPS.length - 1, i + 1)])} style={btnSm}>+</button>
        </div>
      </div>
      <input type="range" min={0} max={EC_STEPS.length - 1} step={1} value={i} aria-label="Error coefficient"
        onChange={(e) => set(EC_STEPS[parseInt(e.target.value, 10)])}
        style={{ width: "100%", marginTop: 8, accentColor: C.chw }} />
    </div>
  );
}

/* Live count of people using the trainer right now. Renders nothing if the
   presence endpoint is unreachable, so a dist-only deploy still works. */
function ActiveCount() {
  const [n, setN] = useState(null);
  useEffect(() => {
    const id = globalThis.crypto?.randomUUID
      ? globalThis.crypto.randomUUID()
      : `s-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let alive = true;
    const beat = async () => {
      try {
        const r = await fetch(`/api/presence?id=${id}`, { cache: "no-store" });
        if (!r.ok) throw new Error("unavailable");
        const d = await r.json();
        if (alive) setN(typeof d.count === "number" ? d.count : null);
      } catch {
        if (alive) setN(null);
      }
    };
    beat();
    const t = setInterval(beat, 20_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  if (!n || n < 1) return null;
  return <span style={{ opacity: 0.75 }}> · {n} active</span>;
}

function Modal({ children, onClose, wide }) {
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(20,26,29,.72)", display: "flex", alignItems: "center", justifyContent: "center", padding: 14, zIndex: 60 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: C.chassis, borderRadius: 6, maxWidth: wide ? 520 : 460, width: "100%", maxHeight: "88vh", overflowY: "auto", boxShadow: "0 18px 50px rgba(0,0,0,.45)" }}>
        {children}
      </div>
    </div>
  );
}

function HelpSheet({ topic, typical, onClose }) {
  const [open, setOpen] = useState(false);
  const h = HELP[topic];
  return (
    <Modal onClose={onClose} wide>
      <div style={{ background: C.chw, color: "#fff", padding: "14px 16px" }}>
        <div style={{ fontFamily: FONT_D, fontSize: 12.5, letterSpacing: 1.4, opacity: 0.85, fontWeight: 600 }}>Cliff notes</div>
        <div style={{ fontFamily: FONT_D, fontSize: 25, fontWeight: 700, lineHeight: 1.1 }}>{h.title}</div>
      </div>
      <div style={{ padding: 16 }}>
        <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0 }}>{h.short}</p>
        {typical && (
          <div style={{ marginTop: 12, padding: "9px 11px", background: C.chassisDark, borderRadius: 4, fontSize: 12.5, lineHeight: 1.45 }}>
            Typical on the loop you're working: {typical}
          </div>
        )}
        {!open && (
          <button onClick={() => setOpen(true)} style={{ ...btn(false), width: "100%", marginTop: 14 }}>
            Read more
          </button>
        )}
        {open && (
          <div style={{ marginTop: 16 }}>
            {h.more.map((s) => (
              <div key={s.h} style={{ marginBottom: 14 }}>
                <div style={{ fontFamily: FONT_D, fontSize: 18, fontWeight: 600, marginBottom: 3 }}>{s.h}</div>
                <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: 0, color: C.ink }}>{s.p}</p>
              </div>
            ))}
          </div>
        )}
        <button onClick={onClose} style={{ ...btn(true), width: "100%", marginTop: 6 }}>Back to the loop</button>
      </div>
    </Modal>
  );
}



const sheet = `
  button:focus-visible, input:focus-visible { outline: 2px solid ${C.chw}; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  .lab-shell { max-width: 620px; margin: 0 auto; }
  .lab-grid { display: block; }
  @media (min-width: 900px) {
    .lab-shell { max-width: 1180px; }
    .lab-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
      gap: 12px;
      align-items: start;
    }
    .lab-col > *:first-child { margin-top: 0 !important; }
    .lab-col-right { position: sticky; top: 12px; }
  }
  @media (min-width: 1400px) { .lab-shell { max-width: 1320px; } }
`;

function Nav({ view, setView, chal, onExit }) {
  const tab = (active) => ({
    flex: 1, padding: "9px 10px", borderRadius: 4, cursor: "pointer",
    border: `1px solid ${active ? C.bezel : C.bezelLight}`,
    background: active ? C.bezel : "transparent",
    color: active ? C.paper : C.ink,
    fontFamily: FONT_D, fontSize: 15.5, fontWeight: 600, letterSpacing: 0.3,
  });
  return (
    <div className="lab-shell" style={{ display: "flex", gap: 6, marginBottom: 10 }}>
      <button onClick={() => { if (chal) onExit(); setView("train"); }} style={tab(view === "train" && !chal)}>
        Train
      </button>
      <button onClick={() => setView("board")} style={tab(view === "board" || !!chal)}>
        Challenges
      </button>
    </div>
  );
}

/* ============================================================
   LEADERBOARD
   ============================================================ */


/* Copies a link straight to this challenge's board. Falls back to a text
   box if the clipboard API isn't available — it needs HTTPS, and someone
   will inevitably open this over plain http on the LAN. */
function ShareButton({ challenge }) {
  const [state, setState] = useState("idle");   // idle | copied | manual
  const url = `${window.location.origin}/?c=${challenge.id}`;

  const share = async () => {
    // On a phone this opens the real share sheet, which is what people want
    if (navigator.share) {
      try {
        await navigator.share({ title: `Loop Lab — ${challenge.title}`, text: "Beat my time.", url });
        return;
      } catch { /* dismissed, fall through to copying */ }
    }
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
      setTimeout(() => setState("idle"), 2500);
    } catch {
      setState("manual");
    }
  };

  return (
    <div style={{ marginTop: 10 }}>
      <button onClick={share}
        style={{ ...btn(false), color: C.paper, borderColor: C.bezelLight, padding: "6px 11px", fontSize: 14 }}>
        {state === "copied" ? "Link copied" : "Share this board"}
      </button>
      {state === "manual" && (
        <input readOnly value={url} onFocus={(e) => e.target.select()}
          aria-label="Link to this challenge"
          style={{
            display: "block", width: "100%", marginTop: 8, padding: "7px 9px",
            fontFamily: FONT_B, fontSize: 12.5, borderRadius: 4,
            border: `1px solid ${C.bezelLight}`, background: C.chassis, color: C.ink,
          }} />
      )}
    </div>
  );
}

function Leaderboard({ initial, onPlay }) {
  const [cid, setCid] = useState(initial || CHALLENGES[0].id);
  const [scores, setScores] = useState(null);
  const [err, setErr] = useState(null);
  const [pin, setPin] = useState("");        // held only while the tab is open
  const [pinDraft, setPinDraft] = useState("");
  const [target, setTarget] = useState(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const ch = CHALLENGES.find((c) => c.id === cid);

  const load = useCallback(async (id) => {
    setScores(null); setErr(null);
    try { setScores(await API.board(id)); }
    catch (e) { setErr(e.message); }
  }, []);

  useEffect(() => { load(cid); }, [cid, load]);

  // Keep the URL pointing at whichever board is on screen, so copying from
  // the address bar works as well as the share button. replaceState rather
  // than pushState: flicking between boards shouldn't fill up the back button.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.get("c") !== cid) {
        u.searchParams.set("c", cid);
        window.history.replaceState({}, "", u);
      }
    } catch { /* no history API, nothing lost */ }
  }, [cid]);

  const openAdmin = async (row) => {
    setTarget(row); setDraft(row.name); setErr(null);
    if (pin && !(await API.checkPin(pin))) setPin("");
  };

  const unlock = async (candidate) => {
    setBusy(true);
    try {
      if (await API.checkPin(candidate)) { setPin(candidate); setErr(null); setPinDraft(""); }
      else setErr("That PIN was not accepted.");
    } catch { setErr("Could not reach the server."); }
    setBusy(false);
  };

  const doEdit = async () => {
    setBusy(true);
    try { const r = await API.edit(target.id, pin, { name: draft }); setScores(r.scores); setTarget(null); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const doDelete = async () => {
    setBusy(true);
    try { const r = await API.remove(target.id, pin); setScores(r.scores); setTarget(null); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  };

  const card = { background: C.chassis, border: `1px solid ${C.chassisDark}`, borderRadius: 5, padding: 14, marginTop: 10 };

  return (
    <div className="lab-shell">
      <div style={{ background: C.bezel, borderRadius: 5, padding: "12px 14px" }}>
        <div style={{ fontFamily: FONT_D, fontSize: 12.5, color: C.gridBold, letterSpacing: 1.6, fontWeight: 600 }}>LEADERBOARD</div>
        <div style={{ fontFamily: FONT_D, fontSize: 25, fontWeight: 700, color: C.paper, lineHeight: 1.05 }}>{ch.title}</div>
        <div style={{ fontSize: 12.5, color: C.chassisDark, marginTop: 3, lineHeight: 1.45 }}>{ch.blurb}</div>
        <ShareButton challenge={ch} />
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
        {CHALLENGES.map((c) => (
          <button key={c.id} onClick={() => setCid(c.id)}
            style={{
              flex: "1 1 auto", padding: "8px 10px", borderRadius: 4, cursor: "pointer",
              border: `1px solid ${c.id === cid ? C.bezel : C.bezelLight}`,
              background: c.id === cid ? C.bezel : "transparent",
              color: c.id === cid ? C.paper : C.ink,
              fontFamily: FONT_D, fontSize: 14.5, fontWeight: 600,
            }}>{c.title}</button>
        ))}
      </div>

      <div style={card}>
        {scores == null && !err && <div style={{ fontSize: 13, color: C.label }}>Loading…</div>}
        {err && !target && (
          <div style={{ fontSize: 13, color: C.fault, lineHeight: 1.5 }}>
            {err}
            <button onClick={() => load(cid)} style={{ ...btn(false), marginLeft: 10, padding: "4px 10px", fontSize: 13 }}>Retry</button>
          </div>
        )}
        {scores && scores.length === 0 && (
          <div style={{ fontSize: 13.5, color: C.label, lineHeight: 1.55 }}>
            Nobody has posted a time on this one yet. Whoever goes first sets the bar.
          </div>
        )}
        {scores && scores.length > 0 && (
          <div>
            {scores.map((row) => (
              <button key={row.id} onClick={() => openAdmin(row)}
                title="Admin: edit or remove"
                style={{
                  display: "flex", width: "100%", alignItems: "center", gap: 10,
                  padding: "9px 6px", background: "transparent", cursor: "pointer",
                  border: "none", borderBottom: `1px solid ${C.chassisDark}`,
                  fontFamily: FONT_B, textAlign: "left", color: C.ink,
                }}>
                <span style={{
                  fontFamily: FONT_D, fontSize: 19, fontWeight: 700, minWidth: 30,
                  color: row.rank === 1 ? C.amber : C.label,
                }}>{row.rank}</span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: FONT_D, fontSize: 19, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {row.name}
                  </span>
                  <span style={{ display: "block", fontSize: 11, color: C.label, whiteSpace: "nowrap" }}>
                    {shortDate(row.at)} · {row.attempts || 1} {(row.attempts || 1) === 1 ? "run" : "runs"}
                  </span>
                </span>
                <span style={{ fontFamily: FONT_D, fontSize: 20, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                  {mmss(row.seconds)}
                </span>
              </button>
            ))}
            <div style={{ fontSize: 11, color: C.label, paddingTop: 9 }}>
              One time per person per challenge — a better run replaces the old one.
              The date is when that time was set; runs counts every completed attempt.
            </div>
          </div>
        )}
      </div>

      <button onClick={() => onPlay(cid)} style={{ ...btn(true), width: "100%", marginTop: 10, padding: "12px 14px", fontSize: 18 }}>
        Run this challenge
      </button>

      <div style={{ textAlign: "center", fontSize: 11, color: C.label, padding: "14px 0 6px" }}>Loop Lab · leaderboard</div>

      {target && (
        <Modal onClose={() => { setTarget(null); setErr(null); }}>
          <div style={{ background: C.bezel, color: C.paper, padding: "14px 16px" }}>
            <div style={{ fontFamily: FONT_D, fontSize: 12.5, letterSpacing: 1.4, opacity: 0.8, fontWeight: 600 }}>ENTRY</div>
            <div style={{ fontFamily: FONT_D, fontSize: 24, fontWeight: 700 }}>{target.name} — {mmss(target.seconds)}</div>
          </div>
          <div style={{ padding: 16 }}>
            {!pin ? (
              <>
                <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: "0 0 12px" }}>
                  Editing and removing entries needs the admin PIN.
                </p>
                <input
                  id="pinbox" type="password" inputMode="numeric" autoComplete="off" placeholder="PIN"
                  value={pinDraft}
                  onChange={(e) => setPinDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") unlock(pinDraft); }}
                  style={{ width: "100%", padding: "10px 12px", fontSize: 18, fontFamily: FONT_D, borderRadius: 4, border: `1px solid ${C.bezelLight}`, background: C.paper, color: C.ink }}
                />
                {err && <div style={{ color: C.fault, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                  <button disabled={busy} onClick={() => unlock(pinDraft)}
                    style={{ ...btn(true), flex: 1 }}>Unlock</button>
                  <button onClick={() => { setTarget(null); setErr(null); }} style={btn(false)}>Cancel</button>
                </div>
              </>
            ) : (
              <>
                <label style={{ fontSize: 11.5, color: C.label }}>Name</label>
                <input value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={20}
                  style={{ width: "100%", padding: "10px 12px", fontSize: 18, fontFamily: FONT_D, borderRadius: 4, border: `1px solid ${C.bezelLight}`, background: C.paper, color: C.ink, marginTop: 4 }} />
                {err && <div style={{ color: C.fault, fontSize: 12.5, marginTop: 8 }}>{err}</div>}
                <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
                  <button disabled={busy || !draft.trim()} onClick={doEdit} style={{ ...btn(true), flex: 1 }}>Save name</button>
                  <button disabled={busy} onClick={doDelete}
                    style={{ ...btn(false), borderColor: C.fault, color: C.fault }}>Delete entry</button>
                  <button onClick={() => { setTarget(null); setErr(null); }} style={btn(false)}>Cancel</button>
                </div>
                <div style={{ fontSize: 11, color: C.label, marginTop: 10, lineHeight: 1.45 }}>
                  Renaming onto a name that already has a time merges the two and keeps the better one.
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

/* ============================================================
   APP
   ============================================================ */

export default function App() {
  const [l, setL] = useState(L[0]);
  const [mode, setMode] = useState("generic");
  const [g, setG] = useState({ ...L[0].start, ec: 1 });
  const [run, setRun] = useState(true);
  const [speed, setSpeed] = useState(L[0].speed);
  const [span, setSpan] = useState(L[0].spans[0]);
  const [v, setV] = useState({ pv: 0, sp: 0, u: 0, t: 0, hist: [], verified: null, travel: 0, event: null, passes: 0 });
  const [diag, setDiag] = useState(null);
  const [help, setHelp] = useState(null);
  const [picker, setPicker] = useState(false);
  const [hints, setHints] = useState(0);
  const [debrief, setDebrief] = useState(null);
  // A ?c=<challenge> link opens straight onto that board.
  const shared = (() => {
    try {
      const c = new URL(window.location.href).searchParams.get("c");
      return CHALLENGES.some((x) => x.id === c) ? c : null;
    } catch { return null; }
  })();
  const [view, setView] = useState(shared ? "board" : "train");   // train | board
  const [chal, setChal] = useState(null);           // active challenge definition
  const [result, setResult] = useState(null);       // finished run awaiting a name
  const [name, setName] = useState("");
  const [posting, setPosting] = useState(false);
  const [postErr, setPostErr] = useState(null);
  const [posted, setPosted] = useState(null);

  const sim = useRef(makeSim(L[0]));
  const R = useRef({});
  R.current = {
    g, run, speed, l, mode, chal,
    finish: (secs) => { setRun(false); setResult({ seconds: secs, challenge: chal }); },
  };

  const load = useCallback((nl, m) => {
    sim.current = makeSim(nl);
    setL(nl);
    setG(m === "siemens" ? { ...nl.start, ...SIEMENS_DEFAULT } : { ...nl.start, ec: 1 });
    setSpeed(nl.speed); setSpan(nl.spans[0]);
    setDiag(null); setDebrief(null); setHints(0); setRun(true);
  }, []);

  // A challenge is deterministic: same loop, same starting gains, same
  // setpoint move for everyone. The disturbance fires automatically once the
  // first recovery is verified, so the run needs no further setup.
  const startChallenge = useCallback((id) => {
    const c = CHALLENGES.find((x) => x.id === id) || CHALLENGES[0];
    const base = L.find((x) => x.id === c.loop);
    const lesson = { ...base, start: c.start, challenge: c.id };
    sim.current = makeSim(lesson);
    setL(lesson);
    setG(convert({ ...c.start, ec: 1 }, lesson, "generic", R.current.mode));
    setSpan(lesson.spans[0]);
    setSpeed(1);                       // challenges run in real time
    setChal(c); setView("train"); setResult(null); setPosted(null);
    setPostErr(null); setName(""); setDiag(null); setDebrief(null); setHints(0);
    setRun(true);

    // fire the opening setpoint move immediately so the clock starts honestly
    const s0 = sim.current;
    const [lo, hi] = lesson.sp.range;
    s0.sp = clamp(lesson.sp.init + c.step, lo, hi);
    s0.stepAt = 0; s0.inBand = 0; s0.verified = null; s0.worst = 0;
    s0.event = { t: 0, text: `Challenge started — setpoint moved to ${fmt(s0.sp, lesson)} ${lesson.io.unit}` };
  }, []);

  const submitScore = async () => {
    if (!result || !name.trim()) return;
    setPosting(true); setPostErr(null);
    try {
      setPosted(await API.submit(result.challenge.id, name.trim(), result.seconds));
    } catch (e) {
      setPostErr(e.message + ". Your time is still on screen — try again.");
    }
    setPosting(false);
  };

  const exitChallenge = useCallback(() => {
    setChal(null); setResult(null); setPosted(null); setPostErr(null);
    load(L[0], R.current.mode);
  }, [load]);

  // Switching flavour keeps the loop behaving exactly as it was.
  // Read mode/l from render scope, not from the ref: StrictMode invokes
  // state updaters twice, and by the second pass the ref already holds the
  // new mode, so convert() would see from === to and silently do nothing.
  const switchMode = (next) => {
    if (next === mode) return;
    setG(convert(g, l, mode, next));
    setMode(next);
    setDiag(null);
  };

  useEffect(() => {
    let raf, last = performance.now(), acc = 0, ui = 0;
    const tick = (now) => {
      const real = Math.min(0.25, (now - last) / 1000);
      last = now;
      const { g: gg, run: rr, speed: ss, l: ll, mode: mm } = R.current;
      if (rr) {
        acc += real * ss;
        let n = 0;
        while (acc >= DT && n < 6000) { step(sim.current, ll, gg, DT, mm); acc -= DT; n++; }
        if (acc > DT) acc = 0;
      }
      // Challenge script: settle the loop, then ride out five disturbances.
      // Each verified recovery throws the next one. A tune that survives one
      // load change can be luck; surviving five is a tune.
      const cc = R.current.chal;
      if (cc) {
        const s = sim.current;
        if (s.passes >= 1 && s.passes <= CHAL_EVENTS && (s.thrown || 0) < s.passes) {
          s.thrown = s.passes;
          const ev = cc.events[(s.passes - 1) % cc.events.length];
          if (ev && ev.trip) rollTrip(s, R.current.l, ev.trip, ev.text);
          else rollEventFixed(s, R.current.l, ev);
        }
        if (s.passes > CHAL_EVENTS && !s.done) {
          s.done = true;
          R.current.finish(Math.round(s.t));
        }
      }

      ui += real;
      if (ui > 0.06) {
        ui = 0;
        const s = sim.current;
        setV({ pv: s.pv, sp: s.sp, u: s.out, t: s.t, hist: s.hist.slice(), verified: s.verified, travel: (s.travel / Math.max(1, s.t)) * 3600, event: s.event, passes: s.passes, worst: s.worst });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const err = v.pv - v.sp;

  // Worsening is reported immediately; improving needs to clear the boundary
  // by 25% before it counts. Without that, a measurement parked exactly on
  // the edge flips the label many times a second and the row jumps around.
  const lvlRef = useRef(0);
  {
    const a = Math.abs(err), b = l.sp.band;
    const raw = a <= b ? 0 : a <= b * 3 ? 1 : 2;
    const prev = lvlRef.current;
    if (raw > prev) lvlRef.current = raw;
    else if (raw < prev) {
      const clear = raw === 0 ? a <= b * 0.75 : a <= b * 2.25;
      if (clear) lvlRef.current = raw;
    }
  }
  const level = lvlRef.current;
  const state = STATES[level].label;
  const sc = STATES[level].color;
  const card = { background: C.chassis, border: `1px solid ${C.chassisDark}`, borderRadius: 5, padding: 14, marginTop: 10 };

  const groups = [...new Set(L.map((x) => x.group))];

  if (view === "board") {
    return (
      <div style={{ background: C.chassis, minHeight: "100vh", padding: 12, fontFamily: FONT_B, color: C.ink }}>
        <style>{sheet}</style>
        <Nav view={view} setView={setView} chal={chal} onExit={exitChallenge} />
        <Leaderboard initial={chal?.id || shared} onPlay={(id) => startChallenge(id)} />
      </div>
    );
  }

  return (
    <div style={{ background: C.chassis, minHeight: "100vh", padding: 12, fontFamily: FONT_B, color: C.ink }}>
      <div className="lab-shell">
        <Nav view={view} setView={setView} chal={chal} onExit={exitChallenge} />
      <style>{sheet}</style>

      <div style={{ background: C.bezel, borderRadius: "5px 5px 0 0", padding: "12px 14px", display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: FONT_D, fontSize: 12.5, color: C.gridBold, letterSpacing: 1.6, fontWeight: 600 }}>
            {l.blind ? `${l.order} · ${l.tag}` : l.tag}
          </div>
          <div style={{ fontFamily: FONT_D, fontSize: 25, fontWeight: 700, color: C.paper, lineHeight: 1.05, marginTop: 2 }}>
            {l.blind ? "Fault unknown" : l.name}
          </div>
        </div>
        {!chal && <button onClick={() => setPicker(true)} style={{ ...btn(false), color: C.paper, borderColor: C.bezelLight, padding: "7px 11px", fontSize: 14, flexShrink: 0 }}>Change loop</button>}
      </div>
      <div style={{ background: C.bezelLight, padding: "9px 14px", color: C.paper, fontSize: 12.5, lineHeight: 1.5, borderBottom: `4px solid ${C.bezel}` }}>
        {l.blind ? l.complaint : l.brief}
      </div>
      {chal && (
        <div style={{ background: C.bezelLight, color: C.paper, padding: "9px 14px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: `4px solid ${C.bezel}`, marginTop: -4 }}>
          <span style={{ fontFamily: FONT_D, fontSize: 21, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: result ? C.ok : C.paper }}>
            {mmss(v.t)}
          </span>
          <span style={{ fontSize: 12.5 }}>
            {v.passes > CHAL_EVENTS
              ? "Run complete"
              : v.passes === 0
                ? `Settle it, then ride out ${CHAL_EVENTS} disturbances`
                : `Recovered ${v.passes} of ${CHAL_EVENTS + 1} — ${CHAL_EVENTS + 1 - v.passes} to go`}
          </span>
          <span style={{ marginLeft: "auto", fontFamily: FONT_D, fontWeight: 700, fontSize: 15, fontVariantNumeric: "tabular-nums" }}>
            {Math.min(v.passes, CHAL_EVENTS + 1)} of {CHAL_EVENTS + 1}
          </span>
        </div>
      )}

      {l.blind && (
        <div style={{ background: C.amber, color: "#241a05", padding: "8px 14px", fontSize: 12.5, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", borderBottom: `4px solid ${C.bezel}`, marginTop: -4 }}>
          <span style={{ fontFamily: FONT_D, fontSize: 16, fontWeight: 700 }}>
            {Math.min(v.passes, BLIND_PASSES)} of {BLIND_PASSES} recoveries verified
          </span>
          <span style={{ opacity: 0.85 }}>Step it, disturb it, then sign off.</span>
          <span style={{ marginLeft: "auto", fontFamily: FONT_D, fontWeight: 700, fontSize: 15 }}>{hints} hints</span>
        </div>
      )}

      <div className="lab-grid">
      <div className="lab-col">

      <div style={{ background: C.bezel, padding: "10px 10px 6px", borderRadius: "0 0 5px 5px" }}>
        <div style={{ background: C.paper, borderRadius: 3, overflow: "hidden" }}>
          <Chart hist={v.hist} sp={v.sp} span={span} l={l} />
        </div>
        <div style={{ display: "flex", gap: 13, padding: "8px 4px 2px", flexWrap: "wrap", fontSize: 11, color: C.chassisDark }}>
          <span><i style={{ display: "inline-block", width: 14, height: 2, background: C.ink, verticalAlign: "middle", marginRight: 5 }} />measured</span>
          <span><i style={{ display: "inline-block", width: 14, height: 2, background: C.chw, verticalAlign: "middle", marginRight: 5 }} />setpoint</span>
          <span><i style={{ display: "inline-block", width: 14, height: 2, background: l.io.color, verticalAlign: "middle", marginRight: 5 }} />{l.io.outShort}</span>
          <span style={{ marginLeft: "auto" }}>
            {l.spans.map((s) => (
              <button key={s} onClick={() => setSpan(s)} style={{ background: "none", border: "none", color: span === s ? C.paper : C.chassisDark, fontFamily: FONT_D, fontSize: 14, cursor: "pointer", padding: "0 5px" }}>
                {s >= 3600 ? `${s / 3600}h` : s >= 60 ? `${s / 60}m` : `${s}s`}
              </button>
            ))}
          </span>
        </div>
      </div>

      <div style={{ ...card, display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <Readout label={cap(l.io.pv)} value={fmt(v.pv, l)} unit={l.io.unit} big color={sc} />
        <Readout label="Setpoint" value={fmt(v.sp, l)} unit={l.io.unit} color={C.chw} />
        <Readout label={cap(l.io.outShort)} value={v.u.toFixed(0)} unit="%" color={l.io.color} />
        {/* Width is pinned to the longest label. Left to size itself, this
            block grows when the text changes, wraps onto its own line, and
            shoves the whole page down — several times a second when the
            measurement is sitting right on the edge of the band. */}
        <div style={{ marginLeft: "auto", textAlign: "right", minWidth: 124, flexShrink: 0 }}>
          <div style={{ fontFamily: FONT_D, fontSize: 18, fontWeight: 600, color: sc, whiteSpace: "nowrap" }}>{state}</div>
          <div style={{ fontSize: 11, color: C.label, whiteSpace: "nowrap" }}>{v.travel.toFixed(0)} %/hr travel</div>
        </div>
      </div>

      {v.event && (
        <div style={{ marginTop: 8, padding: "9px 12px", borderRadius: 4, background: C.bezelLight, color: C.paper, fontSize: 12.5, lineHeight: 1.45, display: "flex", gap: 8 }}>
          <span style={{ color: C.gridBold, fontFamily: FONT_D, fontWeight: 700, flexShrink: 0 }}>
            {Math.floor(v.event.t / 60)}:{String(Math.floor(v.event.t % 60)).padStart(2, "0")}
          </span>
          <span>{v.event.text}</span>
        </div>
      )}

      {result && (
        <div style={{ ...card, borderColor: C.ok, borderWidth: 2 }}>
          <div style={{ fontFamily: FONT_D, fontSize: 26, fontWeight: 700, color: C.ok }}>
            Finished in {mmss(result.seconds)}
          </div>
          <div style={{ fontSize: 12.5, color: C.label, lineHeight: 1.5, marginTop: 2 }}>
            Two recoveries verified on {result.challenge.title}. Put a name to it and it goes on the board.
          </div>
          {posted ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>
                {posted.improved
                  ? `Posted${posted.rank ? ` at number ${posted.rank}` : ""}.`
                  : posted.message || "Your existing time on this challenge was better, so the board is unchanged."}
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <button onClick={() => setView("board")} style={{ ...btn(true), flex: 1 }}>See the board</button>
                <button onClick={() => startChallenge(result.challenge.id)} style={btn(false)}>Run it again</button>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 12 }}>
              <input
                value={name} onChange={(e) => setName(e.target.value)} maxLength={20}
                placeholder="Your name"
                onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) submitScore(); }}
                style={{ width: "100%", padding: "10px 12px", fontSize: 18, fontFamily: FONT_D, borderRadius: 4, border: `1px solid ${C.bezelLight}`, background: C.paper, color: C.ink }}
              />
              {postErr && <div style={{ color: C.fault, fontSize: 12.5, marginTop: 8 }}>{postErr}</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                <button disabled={posting || !name.trim()} onClick={submitScore} style={{ ...btn(true), flex: 1 }}>
                  {posting ? "Posting…" : "Post my time"}
                </button>
                <button onClick={() => startChallenge(result.challenge.id)} style={btn(false)}>Run it again</button>
              </div>
              <div style={{ fontSize: 11, color: C.label, marginTop: 9, lineHeight: 1.45 }}>
                Reusing a name replaces that person's previous time, but only if this run was faster.
              </div>
            </div>
          )}
        </div>
      )}

      {v.verified != null && (
        <div style={{ marginTop: 8, padding: 14, borderRadius: 5, background: C.ok, color: "#fff" }}>
          <div style={{ fontFamily: FONT_D, fontSize: 22, fontWeight: 700 }}>Settled in {Math.round(v.verified)} s</div>
          <div style={{ fontSize: 12.5, marginTop: 3, opacity: 0.95 }}>
            Held inside ±{fmt(l.sp.band, l)} {l.io.unit} for {holdOf(l)} s after the step, on {v.travel.toFixed(0)} %/hr of travel. Both numbers score in the timed challenge.
          </div>
        </div>
      )}

      </div>
      <div className="lab-col lab-col-right">

      <div style={{ ...card, display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={() => { setDiag(analyze(sim.current, l, g, mode)); if (l.blind) setHints((h) => h + 1); }}
          style={{ ...btn(true), flex: "1 1 100%" }}>
          {l.blind ? `Ask the analyzer — counts as a hint (${hints})` : "Analyze this loop"}
        </button>
        {l.blind && (
          <button onClick={() => setDebrief(buildDebrief(l, g, sim.current, hints, mode))} style={{ ...btn(false), flex: "1 1 100%", borderColor: C.ok, color: C.ok }}>
            Sign off on this loop
          </button>
        )}
        {!chal && <button onClick={() => rollStep(sim.current, l)} style={{ ...btn(false), flex: "1 1 46%" }}>New setpoint</button>}
        {!chal && <button onClick={() => rollEvent(sim.current, l)} style={{ ...btn(false), flex: "1 1 46%" }}>Throw a disturbance</button>}
        <button onClick={() => setRun((r) => !r)} style={{ ...btn(false), flex: 1 }}>{run ? "Freeze" : "Run"}</button>
        <button onClick={() => (chal ? startChallenge(chal.id) : load(l, mode))} style={{ ...btn(false), flex: 1 }}>Restart</button>
        <div style={{ flex: "1 1 100%", display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: C.label, paddingTop: 4 }}>
          <span>Clock</span>
          {(chal ? [1] : [1, 6, 20, 60]).map((s) => (
            <button key={s} onClick={() => setSpeed(s)} style={{ ...btnSm, width: "auto", padding: "0 9px", fontSize: 13.5, background: speed === s ? C.bezel : C.chassis, color: speed === s ? C.paper : C.ink }}>{s}×</button>
          ))}
          {chal && <span style={{ fontSize: 11 }}>real time only · pausing stops the clock</span>}
          <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
            {Math.floor(v.t / 60)}:{String(Math.floor(v.t % 60)).padStart(2, "0")}
          </span>
        </div>
      </div>

      <div style={card}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontFamily: FONT_D, fontSize: 20, fontWeight: 700 }}>Controller settings</div>
          <div style={{ display: "flex", border: `1px solid ${C.bezelLight}`, borderRadius: 4, overflow: "hidden" }}>
            {[["generic", "Generic"], ["siemens", "Siemens"]].map(([m, lab]) => (
              <button key={m} onClick={() => switchMode(m)}
                style={{
                  padding: "5px 12px", border: "none", cursor: "pointer", fontFamily: FONT_D,
                  fontSize: 14.5, fontWeight: 600, letterSpacing: 0.3,
                  background: mode === m ? C.bezel : "transparent",
                  color: mode === m ? C.paper : C.ink,
                }}>{lab}</button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 11.5, color: C.label, marginBottom: 4, display: "flex", alignItems: "center", flexWrap: "wrap" }}>
          Effective gain {round(resolve(g, l, mode).kp)} %/{l.io.unit}
          {mode === "siemens" && resolve(g, l, mode).ec !== 1 ? ` (${round(g.k)} × ${resolve(g, l, mode).ec})` : ""}
          {" · "}{l.blind ? "dead time and stroke time not documented" : `${l.p.dead} s dead time · ${l.io.outShort} strokes in ${l.p.stroke} s`}
          <HelpDot onClick={() => setHelp("proc")} label="dead time and lag" />
        </div>

        {mode === "generic" ? (
          <>
            <Knob label="Proportional band" hint={`Error that drives the ${l.io.outShort} 0 to 100%. Wider is gentler.`}
              value={g.pb} set={(x) => setG({ ...g, pb: x })} range={l.ctrl.pb}
              fmt={(x) => (x < 1 ? x.toFixed(3) : x < 100 ? x.toFixed(1) : x.toFixed(0))} unit={l.io.unit}
              help={() => setHelp("pb")} />
            <Knob label="Integral time" hint={`Seconds to repeat the proportional correction. ${l.ctrl.ti[1]} s switches reset off.`}
              value={g.ti} set={(x) => setG({ ...g, ti: x })} range={l.ctrl.ti}
              fmt={(x) => (x >= l.ctrl.ti[1] ? "off" : x.toFixed(0))} unit={g.ti >= l.ctrl.ti[1] ? "" : "s"}
              help={() => setHelp("ti")} />
            <Knob label="Derivative time" hint="Rate action on the measurement. Usually 0 in HVAC."
              value={g.td} set={(x) => setG({ ...g, td: x })} range={l.ctrl.td}
              fmt={(x) => x.toFixed(0)} unit="s" help={() => setHelp("td")} />
          </>
        ) : (
          <>
            <Knob label="Gain" hint={`Percent of ${l.io.outShort} per unit of error seen by the block. Higher is more aggressive.`}
              value={g.k} set={(x) => setG({ ...g, k: x })} range={SIEMENS.k}
              fmt={(x) => x.toFixed(1)} unit="" help={() => setHelp("gain")} />
            <Knob label="Tn" hint="Integral action time in seconds. 0 switches integral action off."
              value={g.tn} set={(x) => setG({ ...g, tn: x })} range={SIEMENS.tn}
              fmt={(x) => (x > 0 ? x.toFixed(0) : "off")} unit={g.tn > 0 ? "s" : ""} help={() => setHelp("tn")} />
            <EcKnob value={g.ec} set={(x) => setG({ ...g, ec: x })} help={() => setHelp("ec")} l={l} g={g} />
            {(() => {
              // Don't cite the reference tune on a blind call — that's the answer.
              if (l.blind) return null;
              const need = 100 / REF[l.id].pb;
              const reach = need / (g.ec || 1);
              if (reach >= SIEMENS.k[0] && reach <= SIEMENS.k[1]) return null;
              return (
                <div style={{ marginTop: 8, padding: "8px 10px", background: C.amber, color: "#241a05", borderRadius: 4, fontSize: 12, lineHeight: 1.45 }}>
                  At a {g.ec}× coefficient this loop needs a gain of about {round(reach)}, outside the {SIEMENS.k[0]} to {SIEMENS.k[1]} the dial allows. Move the coefficient until the gain you need lands on the dial.
                </div>
              );
            })()}
          </>
        )}
        <div style={{ borderTop: `1px solid ${C.chassisDark}`, paddingTop: 9, marginTop: 2, fontSize: 11.5, color: C.label, display: "flex", alignItems: "center" }}>
          Settles at ±{fmt(l.sp.band, l)} {l.io.unit} held for {holdOf(l)} s
          <HelpDot onClick={() => setHelp("band")} label="the settling band" />
        </div>
      </div>

      </div>
      </div>

      <div style={{ textAlign: "center", fontSize: 11, color: C.label, padding: "14px 0 6px" }}>
        Loop Lab · training mode<ActiveCount /> · v{VERSION}
      </div>
      </div>

      {help && (
        <HelpSheet
          topic={help}
          typical={!l.blind && ["pb", "ti", "gain", "tn", "ec"].includes(help) ? typicalFor(l, mode, g) : null}
          onClose={() => setHelp(null)}
        />
      )}

      {debrief && (
        <Modal onClose={() => setDebrief(null)} wide>
          <div style={{ background: debrief.pass ? C.ok : C.amber, color: debrief.pass ? "#fff" : "#241a05", padding: "14px 16px" }}>
            <div style={{ fontFamily: FONT_D, fontSize: 12.5, letterSpacing: 1.4, opacity: 0.85, fontWeight: 600 }}>{l.order} · debrief</div>
            <div style={{ fontFamily: FONT_D, fontSize: 25, fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>{debrief.head}</div>
          </div>
          <div style={{ padding: 16 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 6, columnGap: 12, fontSize: 12.5, marginBottom: 14 }}>
              {debrief.rows.map(([k, val]) => (
                <React.Fragment key={k}>
                  <span style={{ color: C.label }}>{k}</span>
                  <span style={{ fontFamily: FONT_D, fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{val}</span>
                </React.Fragment>
              ))}
            </div>
            <div style={{ fontFamily: FONT_D, fontSize: 19, fontWeight: 600 }}>What was actually wrong</div>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: "2px 0 10px" }}>
              <strong>{debrief.truth.fault.reveal}.</strong> {debrief.truth.fault.why}
            </p>
            <div style={{ fontFamily: FONT_D, fontSize: 19, fontWeight: 600 }}>The loop you were on</div>
            <p style={{ fontSize: 13.5, lineHeight: 1.6, margin: "2px 0 10px" }}>
              {debrief.truth.name} — {debrief.truth.brief}
            </p>
            <div style={{ borderLeft: `3px solid ${C.chw}`, paddingLeft: 11, fontSize: 13.5, lineHeight: 1.55 }}>{debrief.note}</div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <button onClick={() => load(makeCall(), mode)} style={{ ...btn(true), flex: 1 }}>Next call</button>
              <button onClick={() => setDebrief(null)} style={{ ...btn(false) }}>Keep working</button>
            </div>
          </div>
        </Modal>
      )}

      {diag && (
        <Modal onClose={() => setDiag(null)}>
          <div style={{ background: diag.code === "good" ? C.ok : diag.code === "warm" ? C.bezelLight : C.fault, color: "#fff", padding: "14px 16px" }}>
            <div style={{ fontFamily: FONT_D, fontSize: 12.5, letterSpacing: 1.4, opacity: 0.85, fontWeight: 600 }}>Loop analysis</div>
            <div style={{ fontFamily: FONT_D, fontSize: 25, fontWeight: 700, lineHeight: 1.1, marginTop: 2 }}>{diag.head}</div>
          </div>
          <div style={{ padding: 16 }}>
            {diag.facts && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", rowGap: 6, columnGap: 12, marginBottom: 14, fontSize: 12.5 }}>
                {diag.facts.map(([k, val]) => (
                  <React.Fragment key={k}>
                    <span style={{ color: C.label }}>{k}</span>
                    <span style={{ fontFamily: FONT_D, fontSize: 15, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>{val}</span>
                  </React.Fragment>
                ))}
              </div>
            )}
            <p style={{ fontSize: 13.5, lineHeight: 1.55, margin: "0 0 12px" }}>{diag.detail}</p>
            {diag.fix && <div style={{ borderLeft: `3px solid ${C.chw}`, paddingLeft: 11, fontSize: 13.5, lineHeight: 1.55 }}>{diag.fix}</div>}
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              {diag.apply && (
                <button onClick={() => { setG(applyChange(g, l, mode, diag.apply)); setDiag(null); }} style={{ ...btn(true), flex: 1 }}>Apply this change</button>
              )}
              <button onClick={() => setDiag(null)} style={{ ...btn(false), flex: diag.apply ? "0 0 auto" : 1 }}>
                {diag.apply ? "I'll tune it myself" : "Close"}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {picker && (
        <Modal onClose={() => setPicker(false)}>
          <div style={{ background: C.bezel, color: C.paper, padding: "14px 16px" }}>
            <div style={{ fontFamily: FONT_D, fontSize: 24, fontWeight: 700 }}>Pick a loop to work on</div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>Thirteen loops across air, water, pressure and flow. The physics change; the method doesn't.</div>
          </div>
          <div style={{ padding: 8 }}>
            <button onClick={() => { load(makeCall(), mode); setPicker(false); }}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "12px 11px", marginBottom: 6, background: C.amber, border: "none", borderRadius: 4, cursor: "pointer", fontFamily: FONT_B, color: "#241a05" }}>
              <div style={{ fontFamily: FONT_D, fontSize: 11.5, letterSpacing: 1.3, fontWeight: 700, opacity: 0.7 }}>UNLABELLED</div>
              <div style={{ fontFamily: FONT_D, fontSize: 20, fontWeight: 700, lineHeight: 1.1 }}>Take a random service call</div>
              <div style={{ fontSize: 12, lineHeight: 1.4, marginTop: 3 }}>
                Random equipment, one hidden fault, dynamics shifted so no two calls repeat. Nothing tells you what's wrong. Read the trend, tune it, sign off — then find out.
              </div>
            </button>
            {groups.map((gr) => (
              <div key={gr}>
                <div style={{ fontFamily: FONT_D, fontSize: 13, letterSpacing: 1.5, color: C.label, fontWeight: 700, padding: "10px 10px 4px" }}>{gr}</div>
                {L.filter((x) => x.group === gr).map((x) => (
                  <button key={x.id} onClick={() => { load(x, mode); setPicker(false); }}
                    style={{
                      display: "block", width: "100%", textAlign: "left", padding: "10px", marginBottom: 3,
                      background: x.id === l.id && !l.blind ? C.chassisDark : "transparent",
                      border: `1px solid ${x.id === l.id && !l.blind ? C.bezelLight : "transparent"}`,
                      borderRadius: 4, cursor: "pointer", fontFamily: FONT_B,
                    }}>
                    <div style={{ fontFamily: FONT_D, fontSize: 11.5, letterSpacing: 1.3, color: C.label, fontWeight: 600 }}>{x.tag}</div>
                    <div style={{ fontFamily: FONT_D, fontSize: 18.5, fontWeight: 600, color: C.ink, lineHeight: 1.15 }}>{x.name}</div>
                    <div style={{ fontSize: 12, color: C.label, lineHeight: 1.4, marginTop: 3 }}>{x.brief}</div>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

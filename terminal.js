"use strict";

const el = (id) => document.getElementById(id);
const fmt = (n, decimals = 0) => Number.isFinite(n)
  ? n.toLocaleString("en-US", {maximumFractionDigits: decimals}) : "—";
const utc = (s) => new Date(s).toISOString().slice(11, 19);
const gib = (n) => Number.isFinite(n) ? fmt(n / 2 ** 30, 1) + " GiB" : "—";
let observation;
let chartMode = "modules";
let unavailable = false;
let requestPending = false;
const feedUrl = new URL(el("feed-link").href);
const externalFeed = feedUrl.origin !== location.origin;

function node(tag, text, cls) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}

function freshness() {
  const s = observation;
  const stale = s && !s.complete && Date.now() - Date.parse(s.sample) > 2.25 * s.intervalSeconds * 1000;
  const warning = unavailable || (s && (s.partial || stale));
  const chip = el("feed");
  chip.className = "feed " + (warning ? "warn" : s ? "live" : "");
  chip.lastElementChild.textContent = warning ? "Feed delayed" : !s ? "Connecting" : s.complete ? "Final sample" : "Live feed";
  const notice = el("notice");
  notice.hidden = !warning;
  if (warning) {
    notice.textContent = s
      ? "Showing the last complete module count from " + utc(s.sample) + " UTC. A fresh observation is pending."
      : "The live feed is unavailable. Reconnecting automatically.";
  }
  return !warning;
}

function hardwareSpecs(hw) {
  const specs = node("dl", undefined, "hardware");
  const line = (label, value, detail) => {
    const group = node("div"), description = node("dd");
    description.append(node("strong", value));
    if (detail) description.append(node("small", detail));
    group.append(node("dt", label), description);
    specs.append(group);
  };
  if (hw?.cpu) line("CPU", hw.cpu, fmt(hw.cores) + " cores / " + fmt(hw.threads) + " threads");
  if (hw?.installedBytes) {
    const sticks = hw.dimms || [];
    const types = [...new Set(sticks.map(d => d.type).filter(Boolean))];
    const sizes = [...new Set(sticks.map(d => d.bytes))];
    const clocks = [...new Set(sticks.map(d => d.configuredMTs).filter(Boolean))];
    const layout = sizes.length === 1 ? sticks.length + " × " + gib(sizes[0]) : "";
    const speed = clocks.length === 1 ? fmt(clocks[0]) + " MT/s configured" : "";
    line("RAM", [gib(hw.installedBytes), types.join(" / ")].filter(Boolean).join(" "),
      [layout, speed].filter(Boolean).join(" · "));
  }
  return specs;
}

function workers(s) {
  const box = el("worker-grid");
  const cards = [];
  let online = 0;
  for (const worker of s.workers) {
    const card = node("article", undefined, "worker");
    const head = node("div", undefined, "worker-top");
    const status = node("span", undefined, "worker-state " + worker.state);
    status.append(node("i"), document.createTextNode(worker.state));
    head.append(node("h3", worker.name), status);
    const facts = node("dl", undefined, "worker-data");
    const fact = (label, value) => {
      const line = node("div");
      line.append(node("dt", label), node("dd", value));
      facts.append(line);
    };
    fact("CPU threads busy", fmt(worker.cpu, 1) + " / " + fmt(worker.threads));
    const cpuGlyph = node("dd", undefined, "cpu-bar");
    cpuGlyph.setAttribute("aria-hidden", "true");
    const busy = Number.isFinite(worker.cpu) && worker.threads > 0 ? Math.max(0, Math.min(27, Math.round(27 * worker.cpu / worker.threads))) : 0;
    cpuGlyph.append(node("span", "|".repeat(busy)), node("span", ".".repeat(27 - busy), "off"));
    facts.lastElementChild.className = "cpu-row";
    facts.lastElementChild.append(cpuGlyph);
    fact("Local modules", fmt(worker.modules));
    fact("Cache reuses", fmt(worker.restores));
    if (worker.name === "prod09") fact("Host RAM available", gib(worker.hostAvailableRamBytes));
    else fact("Job RAM incl. cache", gib(worker.jobRamBytes));
    fact("Job swap", gib(worker.swapBytes));
    card.append(head, hardwareSpecs(worker.hardware), facts);
    cards.push(card);
    if (worker.state === "online") online++;
  }
  box.replaceChildren(...cards);
  el("online").textContent = online + " / " + s.workers.length + " ONLINE";
}

function chart(s) {
  const points = s.history;
  if (!points.length) return;
  const prop = chartMode;
  const values = points.map(p => p[prop]).filter(Number.isFinite);
  el("chart-unit").textContent = prop === "modules" ? "DISTINCT MODULES" : "MODULES / MIN";
  el("chart-latest").textContent = "LAST  " + fmt(points.at(-1)[prop], prop === "rate" ? 1 : 0);
  const chart = el("chart");
  if (!values.length || points.length < 2) {
    chart.textContent = "Waiting for comparable samples…";
    return;
  }
  const context = document.createElement("canvas").getContext("2d");
  const style = getComputedStyle(chart);
  context.font = style.fontSize + " " + style.fontFamily;
  const charWidth = context.measureText("0").width;
  const columns = Math.max(12, Math.floor(el("plot").clientWidth / charWidth) - 7);
  const rows = 9;
  const high = Math.max(1, ...values);
  const quantum = 10 ** Math.floor(Math.log10(high)) / 2;
  const ceil = Math.ceil(high / quantum) * quantum;
  const start = Date.parse(points[0].time), end = Date.parse(points.at(-1).time);
  const times = points.map(p => Date.parse(p.time));
  const heights = [];
  let idx = 0;
  for (let x = 0; x < columns; x++) {
    const time = start + (end - start) * x / (columns - 1);
    while (idx + 1 < times.length && Math.abs(times[idx + 1] - time) < Math.abs(times[idx] - time)) idx++;
    const v = points[idx][prop];
    heights.push(Number.isFinite(v) && Math.abs(times[idx] - time) <= 360000 ? Math.round((rows - 1) * v / ceil) : null);
  }
  const frag = document.createDocumentFragment();
  for (let y = rows - 1; y >= 0; y--) {
    const axis = y === rows - 1 || y === 4 || y === 0;
    const axisValue = y * ceil / (rows - 1);
    const tag = axisValue >= 1000 ? fmt(axisValue / 1000, 1) + "k" : fmt(axisValue);
    frag.append(node("span", (axis ? tag : "").padStart(5) + " |", "axis"));
    let previousClass = "", run = "";
    const flush = () => { if (run) frag.append(node("span", run, previousClass)); };
    for (let x = 0; x < columns; x++) {
      const h = heights[x];
      let char = " ", cls = "grid";
      if (h === y) { char = "#"; cls = "peak"; }
      else if (h !== null && h > y) { char = ":"; cls = "fill"; }
      else if (axis || x % 8 === 0) char = ".";
      if (cls !== previousClass) { flush(); run = ""; previousClass = cls; }
      run += char;
    }
    flush();
    if (y) frag.append(document.createTextNode("\n"));
  }
  chart.replaceChildren(frag);
  el("first-time").textContent = utc(points[0].time).slice(0, 5);
  el("last-time").textContent = utc(points.at(-1).time).slice(0, 5);
  el("plot").setAttribute("aria-label", el("chart-unit").textContent + " from " + utc(points[0].time) +
    " to " + utc(points.at(-1).time) + " UTC. Most recent value " + fmt(points.at(-1)[prop], 1) + ".");
}

const stageNames = ["Verifier controls", "Compile submitted modules", "Export the proof", "Replay Lean and nanoda", "Run additional kernel checks"];
const stageGlyph = {done: "[x]", active: "[>]", queued: "[ ]", deferred: "[~]", inspect: "[!]", unknown: "[?]"};
function stages(s) {
  const states = [s.controlsPassed ? "done" : "unknown", ...s.stages];
  el("stages").replaceChildren(...stageNames.map((name, i) => {
    const state = states[i], row = node("li", undefined, state);
    const glyph = node("span", stageGlyph[state], "glyph");
    glyph.setAttribute("aria-hidden", "true");
    row.append(glyph, node("span", name), node("small", state));
    return row;
  }));
  el("phase-note").textContent = s.headline === "Compiling proof modules"
    ? "Compilation measures build progress. The exported proof is checked in the two replay stages."
    : s.headline + ".";
}

function sampleLog(s) {
  const rows = [];
  for (let i = s.history.length - 1; i >= Math.max(0, s.history.length - 5); i--) {
    const p = s.history[i], prev = s.history[i - 1];
    const gain = prev && p.rate !== null ? "+" + fmt(p.modules - prev.modules) : "—";
    const row = node("tr");
    row.append(node("td", utc(p.time)), node("td", fmt(p.modules)), node("td", gain));
    rows.push(row);
  }
  el("sample-log").replaceChildren(...rows);
  const last = s.history.at(-1), now = Date.parse(last.time);
  const window = s.history.filter(p => Date.parse(p.time) >= now - 30 * 60000);
  const first = window[0], elapsed = now - Date.parse(first.time);
  let eta = "";
  if (s.stages[0] === "active" && !s.partial && elapsed >= 16 * 60000 && last.modules > first.modules &&
      window.every((p,i) => p.coverage === last.coverage && (!i || p.rate !== null))) {
    const minutes = Math.ceil(elapsed / 60000 * (s.total - s.modules) / (last.modules - first.modules));
    eta = "Estimated compilation remaining at the recent pace: " + Math.floor(minutes / 60) + "h " + minutes % 60 + "m. Kernel checks follow.";
  }
  el("estimate").textContent = eta;
}

function render(s) {
  const percent = s.modules * 100 / s.total;
  el("stamp").textContent = utc(s.sample);
  el("stamp").dateTime = s.sample;
  el("stamp").title = s.sample;
  el("percent").textContent = percent.toFixed(2);
  el("completed").textContent = fmt(s.modules);
  el("total").textContent = fmt(s.total);
  progressStrip(percent);
  el("rate").textContent = fmt(s.rate, 1);
  const hits = s.workers.map(w => w.restores);
  el("restores").textContent = hits.every(Number.isFinite) ? fmt(hits.reduce((a,b) => a + b, 0)) : "—";
  el("archive").textContent = s.archiveSha256 || "Awaiting matching receipts";
  el("challenge").textContent = s.challengeSha256 || "Awaiting receipt";
  workers(s); chart(s); stages(s); sampleLog(s);
}

function progressStrip(percent) {
  const bar = el("progressbar");
  const style = getComputedStyle(bar);
  const context = document.createElement("canvas").getContext("2d");
  context.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
  const charWidth = context.measureText("#").width + (parseFloat(style.letterSpacing) || 0);
  const segments = Math.min(30, Math.max(5, Math.floor(bar.clientWidth / charWidth) - 3));
  const filled = Math.round(Math.min(100, percent) * segments / 100);
  el("progress-fg").textContent = "#".repeat(filled);
  el("progress-bg").textContent = "-".repeat(segments - filled);
  bar.setAttribute("aria-valuenow", percent.toFixed(2));
}

async function refresh() {
  if (requestPending) return;
  requestPending = true;
  try {
    const url = new URL(feedUrl);
    if (externalFeed) url.searchParams.set("minute", String(Math.floor(Date.now() / 60000)));
    const res = await fetch(url, {cache:"no-store", credentials:"omit", referrerPolicy:"no-referrer", signal:AbortSignal.timeout(10000)});
    if (!res.ok) throw new Error("Feed unavailable");
    const s = await res.json();
    if (!s.history?.length || !s.total) throw new Error("Incomplete sample");
    observation = s;
    unavailable = false;
    render(s);
  } catch {
    unavailable = true;
  } finally {
    requestPending = false;
    freshness();
  }
}

for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => {
    chartMode = button.dataset.mode;
    for (const option of button.parentElement.children) option.setAttribute("aria-pressed", String(option === button));
    if (observation) chart(observation);
  });
}
new ResizeObserver(() => { if (observation) chart(observation); }).observe(el("plot"));
new ResizeObserver(() => { if (observation) progressStrip(100 * observation.modules / observation.total); }).observe(el("progressbar"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
refresh();
setInterval(refresh, externalFeed ? 30000 : 15000);

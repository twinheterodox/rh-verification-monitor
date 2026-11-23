"use strict";

const el = (id) => document.getElementById(id);
const fmt = (n, decimals = 0) => Number.isFinite(n)
  ? n.toLocaleString("en-US", {maximumFractionDigits: decimals}) : "—";
const utc = (s) => new Date(s).toISOString().slice(11, 19);
const gib = (n) => Number.isFinite(n) ? fmt(n / 2 ** 30, 1) + " GiB" : "—";
let observation;
let chartMode = "modules";
let lastPhase;
let unavailable = false;
let requestPending = false;
const feedUrl = new URL(el("feed-link").href);
const externalFeed = feedUrl.origin !== location.origin;
const apiFeed = el("feed-link").dataset.api;
let apiWindow = -1;
let minuteLookup = -1;
let eta = null;

function node(tag, text, cls) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (cls) element.className = cls;
  return element;
}

function freshness() {
  const s = observation;
  const terminal = s && (s.complete || s.stages.some(state => ["discontinued", "deferred", "inspect"].includes(state)));
  const stale = s && !terminal && Date.now() - Date.parse(s.sample) > 2.25 * s.intervalSeconds * 1000;
  const warning = unavailable || (s && (s.partial || stale));
  const chip = el("feed");
  chip.className = "feed " + (warning ? "warn" : s ? "live" : "");
  chip.lastElementChild.textContent = warning ? "Feed delayed" : !s ? "Connecting" : terminal ? "Final sample" : "Live feed";
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

const checkerStates = {queued:"Queued", running:"Running", accepted:"Accepted", rejected:"Rejected",
  error:"Execution error", deferred:"Deferred for RAM", stopped:"Stopped", covered:"Covered in core", "not run":"Did not run"};

function showCheckers(s) {
  const rows = (s.checkers || []).map(check => {
    const row = node("tr", undefined, "checker-" + check.state.replaceAll(" ", "-"));
    const elapsed = node("td", "—");
    if (check.started && (check.ended || check.state === "running")) {
      elapsed.dataset.start = check.started;
      if (check.ended) elapsed.dataset.end = check.ended;
      elapsed.dataset.approx = String(check.observedStart || Boolean(check.ended));
      elapsed.title = check.observedStart ? "Timed from the first observation of this checker." :
        check.ended ? "The end time was observed at the next sample." : "Timed from process start.";
    }
    row.append(node("td", check.pass === "core" ? "Core" : "Full"), node("td", check.name),
      node("td", checkerStates[check.state] || "Unknown"), elapsed);
    return row;
  });
  el("checker-rows").replaceChildren(...rows);
}

function chart(s) {
  const checking = chartMode === "checkers";
  const exporting = chartMode === "export";
  el("history-view").hidden = checking;
  el("checker-view").hidden = !checking;
  el("chart-heading").textContent = checking ? "Proof checkers" : exporting ? "Export history" : "Build history";
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === chartMode));
  }
  if (checking) {
    showCheckers(s);
    stageClocks();
    return;
  }
  const points = exporting ? s.history.filter(p => Number.isFinite(p.exportBytes))
    .map(p => ({...p, export:p.exportBytes / 2 ** 30})) : s.history;
  if (!points.length) return;
  const prop = chartMode;
  const values = points.map(p => p[prop]).filter(Number.isFinite);
  el("chart-unit").textContent = exporting ? "EXPORTED · GiB" : prop === "modules" ? "DISTINCT MODULES" : "MODULES / MIN";
  el("chart-latest").textContent = "LAST  " + fmt(points.at(-1)[prop], exporting ? 2 : prop === "rate" ? 1 : 0);
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
    const tag = axisValue >= 1000 ? fmt(axisValue / 1000, 1) + "k" : fmt(axisValue, exporting ? 1 : 0);
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

const stageNames = ["Verifier controls", "Compile submitted modules", "Export the proof", "Replay Lean and nanoda", "Additional kernel checks (optional)"];
const stageGlyph = {done: "[x]", active: "[>]", queued: "[ ]", discontinued: "[-]", deferred: "[~]", inspect: "[!]", unknown: "[?]"};
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
    : s.stages[3] === "discontinued" ? "Core checks passed. The optional Full pass was discontinued." : s.headline + ".";
}

function sampleLog(s) {
  if (s.stages[1] === "done" && s.checkers?.length) {
    el("sample-metric").textContent = "Checker";
    el("sample-change").textContent = "Event";
    const events = [];
    for (const check of s.checkers) {
      const label = check.name + " · " + check.pass;
      if (check.started) events.push([check.started, label, "Running"]);
      if (check.ended) events.push([check.ended, label, checkerStates[check.state]]);
    }
    const rows = events.sort((a,b) => b[0].localeCompare(a[0])).slice(0,5).map(([time, name, event]) => {
      const row = node("tr");
      row.append(node("td", utc(time)), node("td", name), node("td", event));
      return row;
    });
    if (!rows.length) {
      const row = node("tr"), message = node("td", "Awaiting the first checker observation.");
      message.colSpan = 3; row.append(message); rows.push(row);
    }
    el("sample-log").replaceChildren(...rows);
    return;
  }
  const exporting = Boolean(s.export?.bytes) && s.stages[0] === "done";
  el("sample-metric").textContent = exporting ? "Export · GiB" : "Modules";
  el("sample-change").textContent = exporting ? "Write · MiB/s" : "Gain";
  const rows = [];
  for (let i = s.history.length - 1; i >= Math.max(0, s.history.length - 5); i--) {
    const p = s.history[i], prev = s.history[i - 1];
    const gain = prev && p.rate !== null ? "+" + fmt(p.modules - prev.modules) : "—";
    const row = node("tr");
    row.append(node("td", utc(p.time)), node("td", exporting ? fmt(p.exportBytes / 2 ** 30, 2) : fmt(p.modules)),
      node("td", exporting ? fmt(Number.isFinite(p.exportRate) ? p.exportRate / 2 ** 20 : null, 1) : gain));
    rows.push(row);
  }
  el("sample-log").replaceChildren(...rows);
}

function compilationEstimate(s) {
  if (s.stages[0] !== "active" || s.partial || s.modules >= s.total) return null;
  const last = s.history.at(-1), asOf = Date.parse(last.time);
  const recent = s.history.filter(p => Date.parse(p.time) >= asOf - 30 * 60000);
  const elapsed = asOf - Date.parse(recent[0].time), gain = last.modules - recent[0].modules;
  if (elapsed < 16 * 60000 || gain <= 0 || recent.some((p,i) => p.coverage !== last.coverage || (i && p.rate === null))) return null;
  return {finish: asOf + elapsed * (s.total - s.modules) / gain, window: Math.round(elapsed / 60000)};
}

function stopwatch(start, end) {
  if (!start || !Number.isFinite(end)) return "—";
  const seconds = Math.max(0, Math.floor((end - Date.parse(start)) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(v => String(v).padStart(2, "0")).join(":");
}

const utcFinish = new Intl.DateTimeFormat("en-GB", {day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit", hourCycle:"h23", timeZone:"UTC"});
function stageClocks() {
  const s = observation;
  if (!s) return;
  const timing = s.timing || {};
  const now = Date.now(), sample = Date.parse(timing.asOf || s.sample);
  const delayed = unavailable || s.partial || now - sample > 2.25 * s.intervalSeconds * 1000;
  const stopped = Boolean(timing.ended) || s.stages.some(x => x === "inspect" || x === "deferred") || s.complete;
  const end = timing.ended ? Date.parse(timing.ended) : delayed || stopped ? sample : now;
  const active = s.stages.indexOf("active");
  for (const timer of document.querySelectorAll("#checker-rows [data-start]")) {
    timer.textContent = (timer.dataset.approx === "true" ? "≈" : "") +
      stopwatch(timer.dataset.start, timer.dataset.end ? Date.parse(timer.dataset.end) : end);
  }
  el("clock-stage").textContent = active >= 0 ? ["Compilation","Proof export","Core replay","Additional checks"][active] :
    s.stages[3] === "discontinued" ? "Full checks discontinued" : s.headline;
  el("clock-elapsed").textContent = stopwatch(timing.stageStarted,end);
  el("clock-run").textContent = stopwatch(timing.runStarted,end);
  const finish = el("clock-finish"), basis = el("clock-basis");
  finish.removeAttribute("title");
  if (stopped) {
    finish.textContent = s.complete || s.stages[3] === "discontinued" ? "Finished" : "—";
    basis.textContent = timing.ended ? utc(timing.ended) + " UTC · last stage update" : "";
  } else if (delayed) {
    finish.textContent = "Awaiting sample";
    basis.textContent = "Clocks held at the last observation.";
  } else if (active === 0 && s.modules >= s.total) {
    finish.textContent = "Finalizing";
    basis.textContent = "All module files are present.";
  } else if (active === 0 && eta && eta.finish > now) {
    const minutes = Math.ceil((eta.finish - now) / 60000);
    const minute = Math.round(eta.finish / 60000) * 60000;
    finish.textContent = utcFinish.format(minute);
    finish.title = new Date(minute).toLocaleString(undefined, {dateStyle:"medium", timeStyle:"short"}) + " in your time zone";
    basis.textContent = "~" + Math.floor(minutes / 60) + "h " + minutes % 60 + "m left · " + eta.window + "-min pace";
  } else if (active === 1) {
    finish.textContent = "—";
    basis.textContent = s.export?.state === "hashing" ? "Fingerprinting the completed file." : "Final export size is unknown.";
  } else {
    finish.textContent = active === 0 ? "Estimating…" : "No estimate yet";
    basis.textContent = active === 0 ? "Awaiting a measurable build rate." : "This stage has no measured work total.";
  }
}

function stageOverview(s) {
  const phase = s.stages[0] !== "done" ? "compile" : s.stages[1] !== "done" ? "export" : "replay";
  const compiling = phase === "compile";
  const hasExport = s.history.some(point => Number.isFinite(point.exportBytes));
  const hasChecks = Boolean(s.checkers?.length) && !compiling;
  const viewKey = phase + (phase === "replay" ? hasChecks : phase === "export" ? hasExport : "");
  document.querySelector('[data-mode="export"]').hidden = !hasExport;
  document.querySelector('[data-mode="checkers"]').hidden = !hasChecks;
  if (lastPhase !== viewKey) {
    chartMode = phase === "replay" && hasChecks ? "checkers" : !compiling && hasExport ? "export" : "modules";
    lastPhase = viewKey;
  }
  el("compile-metric").hidden = !compiling;
  el("compile-stats").hidden = !compiling;
  el("progressbar").hidden = !compiling;
  el("stage-metric").hidden = compiling;
  const exported = s.export || {};
  el("expression-stats").hidden = compiling || (phase !== "export" && !Number.isSafeInteger(exported.expressions));
  el("expression-count").textContent = fmt(exported.expressions);
  el("expression-rate-stat").hidden = phase !== "export" || exported.state !== "writing";
  el("expression-rate").textContent = fmt(exported.expressionsPerSecond);
  if (compiling) {
    el("summary-title").textContent = "Compilation";
    return;
  }
  const title = el("summary-title"), value = el("stage-value"), unit = el("stage-unit"), detail = el("stage-detail");
  el("stage-metric").classList.toggle("named", phase === "replay");
  if (phase === "export") {
    const e = s.export || {};
    title.textContent = s.headline;
    value.textContent = Number.isFinite(e.bytes) ? fmt(e.bytes / 2 ** 30, 2) : "—";
    unit.textContent = "GiB";
    detail.textContent = e.state === "hashing" ? "Computing the final SHA-256." :
      e.state === "stopped" ? "Export stopped." : Number.isFinite(e.bytesPerSecond)
      ? fmt(e.bytesPerSecond / 2 ** 20, 1) + " MiB/s since the previous observation"
      : "Waiting for a second export measurement.";
    return;
  }
  unit.textContent = "";
  if (s.verified ?? (s.stages[2] === "done")) {
    title.textContent = "Core checks passed";
    value.textContent = "Verified";
    detail.textContent = "Lean’s default kernel and nanoda accepted the formal proof of all five challenge statements under the three permitted axioms.";
    return;
  }
  const group = (s.checkers || []).filter(c => c.pass === "core");
  const active = group.filter(c => c.state === "running").map(c => c.name);
  title.textContent = "Core proof replay";
  value.textContent = s.stages.includes("deferred") ? "Deferred for RAM" :
    s.stages.includes("inspect") ? "Needs inspection" : active.length ? active.join(" + ") : "Awaiting checker report";
  const accepted = group.filter(c => c.state === "accepted").length;
  detail.textContent = group.length
    ? accepted + " of " + group.length + " checkers have recorded acceptance in this pass." : s.headline + ".";
}

function render(s) {
  const percent = s.modules * 100 / s.total;
  const remaining = s.total - s.modules;
  el("stamp").textContent = utc(s.sample);
  el("stamp").dateTime = s.sample;
  el("stamp").title = s.sample;
  el("cadence").textContent = s.intervalSeconds === 60 ? "One-minute samples" : Math.round(s.intervalSeconds / 60) + "-minute samples";
  el("percent").textContent = (remaining > 0 ? Math.min(99.99, percent) : percent).toFixed(2);
  el("completed").textContent = fmt(s.modules);
  el("total").textContent = fmt(s.total);
  const remainingLabel = el("remaining");
  if (remainingLabel) remainingLabel.textContent = " · " + fmt(remaining) + " remaining";
  stageOverview(s);
  if (!el("progressbar").hidden) progressStrip(s.modules, s.total);
  el("rate").textContent = fmt(s.rate, 1);
  const hits = s.workers.map(w => w.restores);
  el("restores").textContent = hits.every(Number.isFinite) ? fmt(hits.reduce((a,b) => a + b, 0)) : "—";
  el("archive").textContent = s.archiveSha256 || "Awaiting matching receipts";
  el("challenge").textContent = s.challengeSha256 || "Awaiting receipt";
  el("export-size").textContent = Number.isFinite(s.export?.finalBytes)
    ? fmt(s.export.finalBytes) + " bytes (" + fmt(s.export.finalBytes / 2 ** 30, 2) + " GiB)" : "Awaiting final size";
  el("export-digest").textContent = s.export?.sha256 || "Awaiting fingerprint";
  eta = compilationEstimate(s);
  workers(s); chart(s); stages(s); sampleLog(s); stageClocks();
}

function progressStrip(modules, total) {
  const bar = el("progressbar");
  const style = getComputedStyle(bar);
  const context = document.createElement("canvas").getContext("2d");
  context.font = style.fontWeight + " " + style.fontSize + " " + style.fontFamily;
  const charWidth = context.measureText("#").width + (parseFloat(style.letterSpacing) || 0);
  const segments = Math.min(30, Math.max(5, Math.floor(bar.clientWidth / charWidth) - 3));
  const filled = Math.min(segments, Math.floor(segments * modules / total));
  el("progress-fg").textContent = "#".repeat(filled);
  el("progress-bg").textContent = "-".repeat(segments - filled);
  bar.setAttribute("aria-valuemax", total);
  bar.setAttribute("aria-valuenow", modules);
  bar.setAttribute("aria-valuetext", fmt(modules) + " of " + fmt(total) + " modules compiled");
}

async function readFeed(url, headers = {}) {
  const res = await fetch(url, {headers, cache:"no-store", credentials:"omit", referrerPolicy:"no-referrer", signal:AbortSignal.timeout(10000)});
  if (!res.ok) throw new Error("Feed unavailable");
  const s = await res.json();
  if (!s.history?.length || !s.total) throw new Error("Incomplete sample");
  return s;
}

async function fetchLatest() {
  if (!externalFeed) return readFeed(feedUrl);
  const now = Date.now();
  // Each observation has a new file name. A cached response cannot hide a later minute.
  const slot = Math.floor((now - 40000) / 60000);
  if (observation && !observation.partial && Math.floor(Date.parse(observation.sample) / 60000) >= slot) return observation;
  if (minuteLookup !== slot) {
    minuteLookup = slot;
    const iso = new Date(slot * 60000).toISOString();
    const day = iso.slice(0,10).replaceAll("-", ""), minute = iso.slice(11,16).replace(":", "");
    try {
      const sample = await readFeed(new URL("samples/" + day + "/" + minute + ".json", feedUrl));
      if (Math.floor(Date.parse(sample.sample) / 60000) === slot) return sample;
    } catch { /* Fall back to the last available observation if a sample is delayed. */ }
  }
  // The normal minute feed is independent of anonymous GitHub API quotas.
  const window = Math.floor(now / 300000);
  if (apiFeed && apiWindow !== window) {
    apiWindow = window;
    try {
      const api = new URL(apiFeed);
      api.searchParams.set("observation", String(window));
      return await readFeed(api, {Accept:"application/vnd.github.raw+json"});
    } catch { /* The public raw copy also works if an anonymous API limit is reached. */ }
  }
  const url = new URL(feedUrl);
  url.searchParams.set("minute", String(Math.floor(now / 60000)));
  return readFeed(url);
}

async function refresh() {
  if (requestPending || (observation?.stages[3] === "discontinued" && !observation.partial)) return;
  requestPending = true;
  try {
    const s = await fetchLatest();
    unavailable = false;
    if (s !== observation && (!observation || Date.parse(s.sample) >= Date.parse(observation.sample))) {
      observation = s;
      render(s);
    }
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
    if (observation) chart(observation);
  });
}
new ResizeObserver(() => { if (observation) chart(observation); }).observe(el("plot"));
new ResizeObserver(() => { if (observation && !el("progressbar").hidden) progressStrip(observation.modules, observation.total); }).observe(el("progressbar"));
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
refresh();
setInterval(stageClocks, 1000);
setInterval(refresh, 15000);

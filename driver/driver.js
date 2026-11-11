/* Bridger Reserve Driver: Start Trip, Start Wait / Resume Trip, End Trip, review, records, private pricing. */
import { cleanRates, DEFAULT_RATES, formatDollars, meterFare, RATE_FIELDS } from "../fare.js";
import { routeUrl } from "../quote-core.js";
import { SYNC_URL } from "./config.js";
import {
  applyFix,
  discardTrip,
  endTrip,
  finalizeTrip,
  flagsFor,
  makeNewStop,
  mergeTrip,
  newTrip,
  openWait,
  reopenTrip,
  resumeTrip,
  settleGap,
  startWait,
  tripsCsv,
} from "./trip.js";

const KEY = "br-driver-v1";
const VERSION = "2026-11-10.1";
const $ = (selector) => document.querySelector(selector);

/* ---------- state, saved on this phone after every change ---------- */
function blank() {
  return { trips: {}, activeId: null, rates: { ...DEFAULT_RATES }, keepAwake: true, pin: "", dirty: [], ratesDirty: false, pulledAt: 0 };
}

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (raw && typeof raw === "object") return { ...blank(), ...raw, rates: cleanRates(raw.rates) };
  } catch {
    /* a blocked or broken store starts clean */
  }
  return blank();
}

const state = load();
let saveTimer = 0;
function save(now = false) {
  clearTimeout(saveTimer);
  const write = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      setSync("error", "Phone storage is full or blocked");
    }
  };
  if (now) write();
  else saveTimer = setTimeout(write, 400);
}

function changed(trip, { soon = true } = {}) {
  if (!state.dirty.includes(trip.id)) state.dirty.push(trip.id);
  save(true);
  if (soon) scheduleSync();
}

const current = () => (state.activeId ? state.trips[state.activeId] : null);

/* ---------- small helpers ---------- */
function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function when(ms) {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

const dollarsToCents = (value) => Math.max(0, Math.round((Number(value) || 0) * 100));

let confirmResolve = null;
function confirmBox(text, yes = "Yes") {
  const dialog = $("#confirm");
  $("#confirm-text").textContent = text;
  $("#confirm-yes").textContent = yes;
  dialog.showModal();
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}
function settle(answer) {
  const resolve = confirmResolve;
  confirmResolve = null;
  if (resolve) resolve(answer);
}
// answer on the tap itself; the dialog's close event can arrive late or not at all on a backgrounded page
$("#confirm").addEventListener("click", (event) => {
  const button = event.target.closest("button[value]");
  if (button) settle(button.value === "yes");
});
$("#confirm").addEventListener("cancel", () => settle(false));
$("#confirm").addEventListener("close", () => settle($("#confirm").returnValue === "yes"));

/* ---------- sync with the staff ledger (Cloudflare Worker + D1) ---------- */
const SYNC_TEXT = {
  local: "Phone only",
  synced: "Synced",
  syncing: "Syncing…",
  offline: "Offline · saved on phone",
  error: "Not synced · saved on phone",
  pin: "PIN needed",
};
function setSync(kind, title = "") {
  const el = $("#sync");
  el.dataset.state = kind;
  el.textContent = SYNC_TEXT[kind] || kind;
  el.title = title;
}

async function api(path, init = {}, pin = state.pin) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(`${SYNC_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${pin}` },
    });
    if (!response.ok) {
      const error = new Error(`sync ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

let syncTimer = 0;
let syncing = false;
function scheduleSync(delay = 1500) {
  if (!SYNC_URL || !state.pin) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncNow, delay);
}

async function syncNow() {
  if (!SYNC_URL || !state.pin || syncing) return;
  if (!navigator.onLine) {
    setSync("offline");
    return;
  }
  syncing = true;
  setSync("syncing");
  try {
    const push = state.dirty.map((id) => state.trips[id]).filter(Boolean);
    if (push.length) {
      const sent = new Map(push.map((t) => [t.id, t.updatedAt]));
      await api("/api/trips", { method: "PUT", body: JSON.stringify({ trips: push }) });
      // anything edited while the request was out stays dirty for the next round
      state.dirty = state.dirty.filter((id) => !state.trips[id] || state.trips[id].updatedAt !== sent.get(id));
    }
    if (state.ratesDirty) {
      await api("/api/settings", { method: "PUT", body: JSON.stringify({ rates: state.rates }) });
      state.ratesDirty = false;
    }
    const data = await api(`/api/trips?since=${encodeURIComponent(state.pulledAt || 0)}`);
    for (const trip of data.trips || []) {
      if (trip && typeof trip.id === "string") state.trips[trip.id] = mergeTrip(state.trips[trip.id], trip);
    }
    if (data.settings && data.settings.rates && !state.ratesDirty) state.rates = cleanRates(data.settings.rates);
    if (Number.isFinite(data.now)) state.pulledAt = data.now;
    save(true);
    setSync("synced", `Last sync ${when(Date.now())}`);
    // never redraw a form the driver may be typing in
    if (tab === "records" || (tab === "trip" && !current())) render();
  } catch (error) {
    if (error && error.status === 401) {
      state.pin = "";
      save(true);
      setSync("pin");
      render();
    } else {
      setSync("error", error && error.message ? error.message : "");
    }
  } finally {
    syncing = false;
    if (state.dirty.length || state.ratesDirty) scheduleSync(20000);
  }
}

/* ---------- GPS ---------- */
let watchId = null;
let lastAccuracy = null;
let gpsProblem = "";
const routing = new Set();

function startGps() {
  if (!("geolocation" in navigator)) {
    gpsProblem = "This phone gives the app no location. Enter the miles at review.";
    return;
  }
  if (watchId !== null) return;
  watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function stopGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
}

function onFix(position) {
  const trip = current();
  if (!trip || trip.status !== "active") return;
  gpsProblem = "";
  lastAccuracy = position.coords.accuracy;
  const result = applyFix(trip, {
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    accuracy: position.coords.accuracy,
    t: Number.isFinite(position.timestamp) ? position.timestamp : Date.now(),
  });
  if (result.gap) {
    changed(trip);
    fillGap(trip.id, result.gap.id);
  } else if (result.accepted) {
    save();
    if (!state.dirty.includes(trip.id)) state.dirty.push(trip.id);
  }
}

function onGpsError(error) {
  gpsProblem =
    error && error.code === 1
      ? "Location is off for this site. Allow it in the phone's settings, or enter the miles at review."
      : "Looking for a GPS signal…";
}

/** A gap while the phone was locked or maps were in front: ask for the road route between the two points. */
async function fillGap(tripId, gapId) {
  const key = `${tripId}:${gapId}`;
  if (routing.has(key) || !navigator.onLine) return;
  const trip = state.trips[tripId];
  const gap = trip && trip.gaps.find((g) => g.id === gapId);
  if (!gap || gap.status === "routed") return;
  routing.add(key);
  try {
    const response = await fetch(routeUrl(gap.from, gap.to));
    const json = await response.json();
    const route = json && json.code === "Ok" && json.routes && json.routes[0];
    if (route && Number.isFinite(route.distance)) {
      settleGap(trip, gapId, route.distance);
      changed(trip);
    }
  } catch {
    /* stays pending and flagged; retried when the signal returns */
  } finally {
    routing.delete(key);
  }
}

function retryGaps() {
  for (const trip of Object.values(state.trips)) {
    if (trip.status !== "active" && trip.status !== "review") continue;
    for (const gap of trip.gaps) if (gap.status !== "routed") fillGap(trip.id, gap.id);
  }
}

/* ---------- keep the screen on while a trip runs ---------- */
let wakeLock = null;
async function holdScreen() {
  const trip = current();
  if (!state.keepAwake || !trip || trip.status !== "active" || !("wakeLock" in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null;
  }
}

function releaseScreen() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

/* ---------- views ---------- */
let tab = "trip";
const VIEWS = ["lock", "ready", "active", "review", "records", "settings"];
function show(name) {
  for (const view of VIEWS) $(`#view-${view}`).hidden = view !== name;
}

function render() {
  const locked = Boolean(SYNC_URL) && !state.pin;
  $(".tabs").hidden = locked;
  for (const button of document.querySelectorAll(".tabs button")) {
    if (button.dataset.view === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  if (locked) return show("lock");
  if (tab === "records") return renderRecords();
  if (tab === "settings") return renderSettings();
  const trip = current();
  if (!trip) return renderReady();
  if (trip.status === "review") return renderReview(trip);
  return renderActive(trip);
}

function renderReady() {
  show("ready");
  const recent = Object.values(state.trips)
    .filter((t) => t.status === "final")
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 3);
  const box = $("#ready-recent");
  box.replaceChildren();
  if (!recent.length) return;
  const title = document.createElement("p");
  title.className = "label";
  title.textContent = "Last trips";
  box.append(title, ...recent.map(recordRow));
}

function renderActive(trip) {
  show("active");
  $("#active-airport").checked = trip.airportPickup;
  tick();
}

function tick() {
  const trip = current();
  if (!trip || trip.status !== "active" || $("#view-active").hidden) return;
  const now = Date.now();
  const m = meterFare(trip, state.rates, now);
  const wait = openWait(trip);
  $("#live-fare").textContent = formatDollars(m.totalCents);
  $("#live-time").textContent = clock(m.elapsedSeconds);
  $("#live-miles").textContent = m.trackedMiles.toFixed(1);
  $("#live-wait").textContent = formatDollars(m.waitCents);
  const mode = $("#mode");
  mode.dataset.mode = wait ? "waiting" : "driving";
  mode.textContent = wait ? "Waiting · time billing paused" : "Driving";
  $("#wait").textContent = wait ? "Resume Trip" : "Start Wait";
  $("#wait-panel").hidden = !wait;
  if (wait) {
    const stop = m.stops.find((s) => s.id === wait.stop);
    const graceSeconds = stop.graceMinutes * 60;
    $("#wait-label").textContent = stop.kind === "pickup" ? (stop.airport ? "Airport pickup" : "Pickup") : `Stop ${stop.id}`;
    $("#wait-clock").textContent = clock(stop.waitedSeconds);
    $("#wait-grace").textContent = `of ${clock(graceSeconds)} included`;
    $("#wait-bar").style.width = `${Math.min(100, (stop.waitedSeconds / Math.max(1, graceSeconds)) * 100)}%`;
    $("#wait-bar").dataset.over = stop.billableSeconds > 0 ? "true" : "false";
    $("#wait-note").textContent =
      stop.billableSeconds > 0
        ? `Billing ${formatDollars(state.rates.waitCentsPerMinute)} a minute by the second: ${formatDollars(Math.round((stop.billableSeconds * state.rates.waitCentsPerMinute) / 60))} at this stop.`
        : `Included. Billing starts at ${clock(graceSeconds)}.`;
  }
  const gps = $("#gps");
  const seen = trip.gps.lastSeen;
  if (gpsProblem) {
    gps.dataset.state = "off";
    gps.textContent = gpsProblem;
  } else if (seen && now - seen < 20000) {
    gps.dataset.state = "on";
    gps.textContent = `GPS on${lastAccuracy ? ` · ±${Math.round(lastAccuracy)} m` : ""}${wakeLock ? " · screen kept on" : ""}`;
  } else {
    gps.dataset.state = "wait";
    gps.textContent = seen ? "GPS paused. Miles for the gap are filled from the road route and flagged." : "GPS starting…";
  }
}

const REVIEW_INPUTS = ["#r-customer", "#r-deposit", "#r-miles", "#r-drive", "#r-wait", "#r-airport", "#r-notes"];
function renderReview(trip) {
  show("review");
  const m = meterFare({ ...trip, adjust: {} }, state.rates);
  const a = trip.adjust || {};
  $("#review-when").textContent = `${when(trip.startedAt)} to ${when(trip.endedAt)}`;
  $("#r-customer").value = trip.customer;
  $("#r-deposit").value = trip.depositPaidCents ? (trip.depositPaidCents / 100).toFixed(2) : "";
  $("#r-miles").value = (a.miles ?? m.trackedMiles).toFixed(1);
  $("#r-drive").value = (a.driveMinutes ?? m.trackedDriveSeconds / 60).toFixed(1);
  $("#r-wait").value = (a.waitMinutes ?? m.trackedBillableWaitSeconds / 60).toFixed(1);
  $("#r-airport").checked = typeof a.airportPickup === "boolean" ? a.airportPickup : trip.airportPickup;
  $("#r-notes").value = trip.notes || "";
  $("#r-miles-tracked").textContent = `Tracked ${m.trackedMiles.toFixed(1)}`;
  $("#r-drive-tracked").textContent = `Tracked ${(m.trackedDriveSeconds / 60).toFixed(1)}`;
  $("#r-wait-tracked").textContent = `Tracked ${(m.trackedBillableWaitSeconds / 60).toFixed(1)}`;
  const flags = flagsFor(trip);
  $("#flags").replaceChildren(
    ...flags.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  drawReviewTotals(trip);
}

function drawReviewTotals(trip) {
  const m = meterFare(trip, state.rates);
  $("#r-lines").replaceChildren(
    ...m.lines.map((line) => {
      const row = document.createElement("div");
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = line.label;
      dd.textContent = formatDollars(line.cents);
      if (line.cents === 0) row.classList.add("is-zero");
      row.append(dt, dd);
      return row;
    }),
  );
  $("#r-total").textContent = formatDollars(m.totalCents);
  $("#r-balance").textContent = formatDollars(m.balanceCents);
}

function readReview(trip) {
  const tracked = meterFare({ ...trip, adjust: {} }, state.rates);
  const edited = (value, trackedValue) => {
    const n = Number(value);
    if (value === "" || !Number.isFinite(n) || n < 0) return null;
    return Math.abs(n - Number(trackedValue.toFixed(1))) < 0.05 ? null : n;
  };
  const airport = $("#r-airport").checked;
  trip.customer = $("#r-customer").value.trim();
  trip.depositPaidCents = dollarsToCents($("#r-deposit").value);
  trip.notes = $("#r-notes").value.trim();
  trip.adjust = {
    miles: edited($("#r-miles").value, tracked.trackedMiles),
    driveMinutes: edited($("#r-drive").value, tracked.trackedDriveSeconds / 60),
    waitMinutes: edited($("#r-wait").value, tracked.trackedBillableWaitSeconds / 60),
    airportPickup: airport === trip.airportPickup ? null : airport,
  };
  trip.updatedAt = Date.now();
}

function recordRow(trip) {
  const li = document.createElement("li");
  li.className = "record";
  const top = document.createElement("p");
  const name = document.createElement("strong");
  name.textContent = trip.customer || "No name";
  const total = document.createElement("span");
  total.className = "record-total";
  const f = trip.final;
  total.textContent = f ? formatDollars(f.totalCents) : trip.status === "review" ? "In review" : "Running";
  top.append(name, total);
  const meta = document.createElement("p");
  meta.className = "record-meta";
  const parts = [`${when(trip.startedAt)}${trip.endedAt ? ` to ${new Date(trip.endedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}`];
  if (f) {
    parts.push(`${f.miles} mi`);
    if (f.airportCents) parts.push(`airport ${formatDollars(f.airportCents)}`);
    if (f.waitCents) parts.push(`waiting ${formatDollars(f.waitCents)}`);
    if (f.depositPaidCents) parts.push(`deposit ${formatDollars(f.depositPaidCents)}, balance ${formatDollars(f.balanceCents)}`);
  }
  if (trip.gaps && trip.gaps.length) parts.push(`${trip.gaps.length} GPS gap${trip.gaps.length > 1 ? "s" : ""} reviewed`);
  meta.textContent = parts.join(" · ");
  li.append(top, meta);
  return li;
}

function renderRecords() {
  show("records");
  const trips = Object.values(state.trips)
    .filter((t) => t.status !== "discarded")
    .sort((a, b) => b.startedAt - a.startedAt);
  const list = $("#records");
  if (!trips.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No trips yet.";
    list.replaceChildren(empty);
  } else {
    list.replaceChildren(...trips.map(recordRow));
  }
  $("#export").disabled = !trips.some((t) => t.status === "final");
}

function renderSettings() {
  show("settings");
  const form = $("#rates");
  form.replaceChildren(
    ...RATE_FIELDS.map((field) => {
      const label = document.createElement("label");
      label.className = "field rate-field";
      const span = document.createElement("span");
      span.textContent = field.label;
      const wrap = document.createElement("span");
      wrap.className = "unit-row";
      const input = document.createElement("input");
      input.type = "number";
      input.inputMode = "decimal";
      input.min = "0";
      input.step = field.cents ? "0.01" : "1";
      input.name = field.key;
      input.value = field.cents ? (state.rates[field.key] / 100).toFixed(2) : String(state.rates[field.key]);
      const unit = document.createElement("small");
      unit.textContent = field.unit;
      if (field.unit === "$") wrap.append(unit, input);
      else wrap.append(input, unit);
      label.append(span, wrap);
      return label;
    }),
  );
  $("#keep-awake").checked = state.keepAwake;
  $("#sign-out").hidden = !SYNC_URL;
  $("#about").textContent = `Version ${VERSION}. ${SYNC_URL ? "Trips and pricing sync to the staff ledger." : "Cloud sync is not set up yet, so trips stay on this phone. Export them from Trips."}`;
}

/* ---------- actions ---------- */
$("#start").addEventListener("click", () => {
  const now = Date.now();
  const trip = newTrip({
    customer: $("#ready-customer").value,
    airportPickup: $("#ready-airport").checked,
    depositPaidCents: dollarsToCents($("#ready-deposit").value),
    now,
  });
  state.trips[trip.id] = trip;
  state.activeId = trip.id;
  $("#ready-customer").value = "";
  $("#ready-airport").checked = false;
  $("#ready-deposit").value = "";
  changed(trip);
  startGps();
  holdScreen();
  tab = "trip";
  render();
});

$("#wait").addEventListener("click", () => {
  const trip = current();
  if (!trip || trip.status !== "active") return;
  if (openWait(trip)) resumeTrip(trip, Date.now());
  else startWait(trip, Date.now());
  changed(trip);
  tick();
});

$("#new-stop").addEventListener("click", () => {
  const trip = current();
  if (!trip) return;
  makeNewStop(trip, Date.now());
  changed(trip);
  tick();
});

$("#active-airport").addEventListener("change", (event) => {
  const trip = current();
  if (!trip) return;
  trip.airportPickup = event.target.checked;
  trip.updatedAt = Date.now();
  changed(trip);
  tick();
});

$("#end").addEventListener("click", async () => {
  const trip = current();
  if (!trip) return;
  if (!(await confirmBox("End the trip here at the drop-off and review the charge?", "End Trip"))) return;
  endTrip(trip, Date.now());
  stopGps();
  releaseScreen();
  changed(trip);
  render();
});

for (const selector of REVIEW_INPUTS) {
  $(selector).addEventListener("input", () => {
    const trip = current();
    if (!trip || trip.status !== "review") return;
    readReview(trip);
    drawReviewTotals(trip);
    changed(trip, { soon: false });
  });
}

$("#finalize").addEventListener("click", async () => {
  const trip = current();
  if (!trip || trip.status !== "review") return;
  readReview(trip);
  const total = formatDollars(meterFare(trip, state.rates).totalCents);
  if (!(await confirmBox(`Finalize ${total} for ${trip.customer || "this trip"}? It is saved to the trip records.`, "Finalize"))) return;
  finalizeTrip(trip, state.rates, Date.now());
  state.activeId = null;
  changed(trip);
  tab = "records";
  render();
});

$("#resume-trip").addEventListener("click", () => {
  const trip = current();
  if (!trip) return;
  readReview(trip);
  reopenTrip(trip, Date.now());
  changed(trip);
  startGps();
  holdScreen();
  render();
});

$("#discard").addEventListener("click", async () => {
  const trip = current();
  if (!trip) return;
  if (!(await confirmBox("Discard this trip? It will not be charged or kept in the records.", "Discard"))) return;
  discardTrip(trip, Date.now());
  state.activeId = null;
  changed(trip);
  render();
});

$("#export").addEventListener("click", () => {
  const csv = tripsCsv(Object.values(state.trips));
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  const d = new Date();
  link.href = URL.createObjectURL(blob);
  link.download = `bridger-reserve-trips-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
});

$("#rates").addEventListener("change", () => {
  const next = {};
  for (const field of RATE_FIELDS) {
    const input = $(`#rates [name="${field.key}"]`);
    next[field.key] = field.cents ? dollarsToCents(input.value) : Number(input.value);
  }
  state.rates = cleanRates(next);
  state.ratesDirty = true;
  save(true);
  scheduleSync();
  renderSettings();
});

$("#keep-awake").addEventListener("change", (event) => {
  state.keepAwake = event.target.checked;
  save(true);
  if (state.keepAwake) holdScreen();
  else releaseScreen();
});

$("#sign-out").addEventListener("click", async () => {
  if (!(await confirmBox("Sign this phone out? Trips already synced stay in the ledger.", "Sign out"))) return;
  state.pin = "";
  save(true);
  setSync("pin");
  render();
});

$("#lock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pin = $("#pin").value.replace(/\D/g, "");
  const error = $("#lock-error");
  if (!/^\d{6}$/.test(pin)) {
    error.textContent = "The PIN is 6 digits.";
    return;
  }
  error.textContent = "Checking…";
  try {
    const session = await api("/api/session", {}, pin);
    state.pin = pin;
    if (session.settings && session.settings.rates) state.rates = cleanRates(session.settings.rates);
    $("#pin").value = "";
    error.textContent = "";
    save(true);
    render();
    syncNow();
  } catch (e) {
    error.textContent = e && e.status === 401 ? "That PIN did not work." : e && e.status === 429 ? "Too many tries. Wait 15 minutes." : "Could not reach the ledger. Check the signal and try again.";
  }
});

for (const button of document.querySelectorAll(".tabs button")) {
  button.addEventListener("click", () => {
    tab = button.dataset.view;
    render();
  });
}

/* ---------- life cycle: a locked phone or a closed app picks up where it left off ---------- */
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    save(true);
    return;
  }
  const trip = current();
  if (trip && trip.status === "active") {
    startGps();
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    }
    holdScreen();
  }
  retryGaps();
  scheduleSync(300);
  render();
});
window.addEventListener("online", () => {
  retryGaps();
  scheduleSync(300);
});
window.addEventListener("pagehide", () => save(true));

setInterval(tick, 1000);
setInterval(() => {
  if (current() && current().status === "active") scheduleSync(0);
}, 60000);

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

setSync(SYNC_URL ? (state.pin ? "syncing" : "pin") : "local");
const resumed = current();
if (resumed && resumed.status === "active") {
  startGps();
  holdScreen();
}
retryGaps();
render();
syncNow();

/* Bridger Reserve: price it before you call. Real road miles and minutes; no rates on the page. */
import { formatDollars } from "./fare.js";
import {
  addressEnds,
  exactPlace,
  geocodeUrl,
  matchPlaces,
  minutesText,
  pairFor,
  placeEnd,
  priceTrip,
  routeFromOsrm,
  routeUrl,
  sameEnd,
  shortName,
  bookingEmail,
  whenText,
} from "./quote-core.js";

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = (selector) => document.querySelector(selector);

const form = $("#quote");
const lines = $("#lines");
const depositLines = $("#deposit-lines");
const total = $("#total");
const totalVisual = $(".total-visual");
const receipt = $(".receipt");
const routeLabel = $("#receipt-route");
const routeEst = $("#receipt-est");
const routeStatus = $("#route-status");
const status = $("#quote-status");
const book = $("#book");
const ack = $("#ack");
const ackText = $("#ack-text");
const dateInput = $("#date");
const timeInput = $("#time");
const nameInput = $("#name");
const phoneInput = $("#phone");
const flightField = $("#flight-field");
const flightInput = $("#flight");
const chips = [...document.querySelectorAll(".chip[data-pair]")];

const ends = {
  from: { key: "from", input: $("#from"), list: $("#from-list"), value: placeEnd("bzn"), noun: "pickup" },
  to: { key: "to", input: $("#to"), list: $("#to-list"), value: placeEnd("downtown"), noun: "drop-off" },
};

let route = null; // { miles, minutes }
let priced = null;
let routeToken = 0;
const routeCache = new Map();

/* ---------- the total rolls to its new value ---------- */
let shownCents = null;
let tween = 0;
function showTotal(cents) {
  cancelAnimationFrame(tween);
  if (cents === null) {
    shownCents = null;
    totalVisual.textContent = "";
    total.textContent = "";
    return;
  }
  total.textContent = `Estimated total ${formatDollars(cents)}`;
  const from = shownCents === null ? cents : shownCents;
  shownCents = cents;
  if (reduce || from === cents) {
    totalVisual.textContent = formatDollars(cents);
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / 420);
    totalVisual.textContent = formatDollars(Math.round(from + (cents - from) * (1 - (1 - p) ** 3)));
    if (p < 1) tween = requestAnimationFrame(step);
  };
  tween = requestAnimationFrame(step);
}

const previous = new Map();
function drawLedger(target, rows) {
  target.replaceChildren(
    ...rows.map((line) => {
      const row = document.createElement("div");
      const name = document.createElement("dt");
      const amount = document.createElement("dd");
      name.textContent = line.label;
      amount.textContent = formatDollars(line.cents);
      if (line.cents === 0) row.classList.add("is-zero");
      if (previous.has(line.id) && previous.get(line.id) !== line.cents && !reduce) amount.classList.add("is-changed");
      previous.set(line.id, line.cents);
      row.append(name, amount);
      return row;
    }),
  );
}

function clearReceipt(message) {
  route = null;
  priced = null;
  lines.replaceChildren();
  depositLines.replaceChildren();
  previous.clear();
  showTotal(null);
  routeEst.textContent = "";
  receipt.classList.remove("is-busy");
  status.textContent = message;
  ack.checked = false;
  ackText.textContent = "I understand the deposit confirms my booking, applies toward my fare, and is not refunded if I cancel.";
  syncBook();
}

/* ---------- pricing ---------- */
function syncChips() {
  const key = ends.from.value && ends.to.value && ends.from.value.kind === "place" && ends.to.value.kind === "place" ? `${ends.from.value.id}|${ends.to.value.id}` : "";
  for (const chip of chips) chip.setAttribute("aria-pressed", chip.dataset.pair === key ? "true" : "false");
}

function syncFlight() {
  const airport = Boolean(ends.from.value && ends.from.value.airport);
  flightField.hidden = !airport;
}

let ackedDepositCents = null;
function draw(from, to, r) {
  route = r;
  priced = priceTrip(from, to, r);
  // the guest agreed to a specific deposit; a new amount needs a new tick
  if (ack.checked && ackedDepositCents !== priced.depositCents) ack.checked = false;
  receipt.classList.remove("is-busy");
  routeEst.textContent = `${r.miles} miles · ${minutesText(r.minutes)}`;
  drawLedger(lines, priced.lines);
  drawLedger(depositLines, priced.deposit);
  showTotal(priced.totalCents);
  ackText.textContent = `I understand the ${formatDollars(priced.depositCents)} deposit confirms my booking, applies toward my fare, and is not refunded if I cancel.`;
  syncBook();
}

async function measure(from, to) {
  const key = `${from.lat.toFixed(5)},${from.lon.toFixed(5)}|${to.lat.toFixed(5)},${to.lon.toFixed(5)}`;
  if (routeCache.has(key)) return routeCache.get(key);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 9000);
  try {
    const response = await fetch(routeUrl(from, to), { signal: controller.signal });
    if (!response.ok) return null;
    const r = routeFromOsrm(await response.json());
    if (r) routeCache.set(key, r);
    return r;
  } finally {
    clearTimeout(timer);
  }
}

async function update() {
  const from = ends.from.value;
  const to = ends.to.value;
  syncChips();
  syncFlight();
  routeLabel.textContent = from && to ? `${shortName(from)} → ${shortName(to)}` : "";
  routeStatus.textContent = "";
  const token = ++routeToken;
  if (!from || !to) {
    clearReceipt(`Choose a ${!from ? "pickup" : "drop-off"} from the list.`);
    return;
  }
  if (sameEnd(from, to)) {
    clearReceipt("Pick two different places.");
    return;
  }
  if (from.kind === "place" && to.kind === "place") {
    draw(from, to, pairFor(from.id, to.id));
    return;
  }
  receipt.classList.add("is-busy");
  routeEst.textContent = "Measuring the route…";
  status.textContent = "Measuring the real road distance and drive time.";
  syncBook();
  let r = null;
  try {
    r = await measure(from, to);
  } catch {
    r = null;
  }
  if (token !== routeToken) return;
  if (!r) {
    clearReceipt("");
    routeStatus.textContent = "We could not measure that route just now. Call 406.551.3198 or email BridgerReserve@gmail.com and Terry or Max will price it.";
    status.textContent = "No price yet for this route.";
    return;
  }
  draw(from, to, r);
}

/* ---------- booking ---------- */
function syncBook() {
  const when = whenText(dateInput.value, timeInput.value);
  let message = "";
  if (!priced) message = status.textContent;
  else if (!when) message = "Add the date and pickup time to request this booking.";
  else if (!ack.checked) message = "Check the deposit box to request this booking.";
  else message = "Ready. Your email app opens with the full request.";
  book.disabled = !(priced && when && ack.checked);
  if (priced) status.textContent = message;
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (book.disabled || !priced) return;
  const mail = bookingEmail({
    from: ends.from.value,
    to: ends.to.value,
    route,
    priced,
    when: whenText(dateInput.value, timeInput.value),
    name: nameInput.value.trim(),
    phone: phoneInput.value.trim(),
    flight: flightInput.value.trim(),
  });
  window.location.href = mail.href;
  status.textContent = "Your email app should open with the request. If it does not, call 406.551.3198 or email BridgerReserve@gmail.com.";
});

for (const el of [dateInput, timeInput]) el.addEventListener("input", syncBook);
ack.addEventListener("change", () => {
  ackedDepositCents = ack.checked && priced ? priced.depositCents : null;
  syncBook();
});
{
  const now = new Date();
  dateInput.min = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/* ---------- address search: Photon, at most one request a second ---------- */
const geocodeCache = new Map();
let geocodeController = null;
let lastGeocodeAt = 0;
async function geocode(query) {
  const key = query.trim().toLowerCase();
  if (geocodeCache.has(key)) return geocodeCache.get(key);
  if (geocodeController) geocodeController.abort();
  const controller = new AbortController();
  geocodeController = controller;
  const wait = Math.max(0, lastGeocodeAt + 1100 - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  if (controller.signal.aborted) throw new DOMException("superseded", "AbortError");
  lastGeocodeAt = Date.now();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(geocodeUrl(query), { signal: controller.signal });
    if (!response.ok) throw new Error(`geocoder ${response.status}`);
    const found = addressEnds(await response.json());
    geocodeCache.set(key, found);
    return found;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- the two place pickers (ARIA combobox) ---------- */
function setupPicker(end) {
  const { input, list } = end;
  let options = [];
  let active = -1;
  let typed = false;
  let searchTimer = 0;
  let addresses = null; // null = not searched, [] = none
  let searching = false;
  let freshFocus = false;

  function open() {
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }

  function close() {
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    active = -1;
  }

  function row(className, text) {
    const li = document.createElement("li");
    li.className = className;
    li.setAttribute("role", "presentation");
    li.textContent = text;
    return li;
  }

  function optionRow(option, n) {
    const li = document.createElement("li");
    li.id = `${end.key}-opt-${n}`;
    li.className = "place-option";
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", n === active ? "true" : "false");
    li.dataset.index = String(n);
    const title = document.createElement("span");
    title.textContent = option.kind === "place" ? option.label : option.title;
    li.append(title);
    if (option.kind === "address" && option.detail) {
      const small = document.createElement("small");
      small.textContent = option.detail;
      li.append(small);
    }
    return li;
  }

  function render() {
    const places = matchPlaces(typed ? input.value : "");
    options = places.map((place) => placeEnd(place.id));
    const out = [];
    let group = "";
    places.forEach((place, n) => {
      if (place.group !== group) {
        group = place.group;
        out.push(row("place-group", group));
      }
      out.push(optionRow(options[n], n));
    });
    if (typed && input.value.trim().length >= 3) {
      out.push(row("place-group", "Addresses"));
      if (addresses && addresses.length) {
        addresses.forEach((address, k) => {
          options.push(address);
          out.push(optionRow(address, places.length + k));
        });
      } else {
        out.push(row("place-note", searching || addresses === null ? "Searching…" : "No address found. Try a street and town, or call us."));
      }
    }
    if (!out.length) out.push(row("place-note", "Keep typing an address, a hotel, or a town."));
    list.replaceChildren(...out);
    if (active >= options.length) active = options.length - 1;
    if (active >= 0) input.setAttribute("aria-activedescendant", `${end.key}-opt-${active}`);
    else input.removeAttribute("aria-activedescendant");
  }

  function highlight(next) {
    active = next;
    for (const li of list.querySelectorAll(".place-option")) li.setAttribute("aria-selected", li.dataset.index === String(active) ? "true" : "false");
    const li = list.querySelector(`#${end.key}-opt-${active}`);
    if (li) {
      input.setAttribute("aria-activedescendant", li.id);
      li.scrollIntoView({ block: "nearest" });
    }
  }

  function choose(option) {
    end.value = option;
    input.value = option.label;
    typed = false;
    addresses = null;
    close();
    update();
  }

  function searchSoon() {
    clearTimeout(searchTimer);
    const query = input.value.trim();
    addresses = null;
    searching = query.length >= 3;
    if (!searching) return;
    searchTimer = setTimeout(async () => {
      try {
        const found = await geocode(query);
        if (input.value.trim() !== query) return;
        addresses = found;
      } catch (error) {
        if (error && error.name === "AbortError") return;
        addresses = [];
      } finally {
        searching = false;
      }
      if (!list.hidden) render();
    }, 350);
  }

  input.addEventListener("focus", () => {
    typed = false;
    addresses = null;
    active = -1;
    render();
    open();
    // typing replaces the current place instead of adding to it
    freshFocus = true;
    input.select();
  });

  // a mouse or tap puts the caret where it lands after focus, so select again on that first click
  input.addEventListener("click", () => {
    if (!freshFocus) return;
    freshFocus = false;
    input.setSelectionRange(0, input.value.length);
  });

  input.addEventListener("input", () => {
    freshFocus = false;
    typed = true;
    active = -1;
    searchSoon();
    render();
    open();
  });

  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (list.hidden) {
        render();
        open();
      }
      if (!options.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      highlight((active + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      if (list.hidden) return;
      event.preventDefault();
      const pick = options[active >= 0 ? active : 0];
      if (pick) choose(pick);
    } else if (event.key === "Escape") {
      if (end.value) input.value = end.value.label;
      typed = false;
      close();
    }
  });

  input.addEventListener("blur", () => {
    clearTimeout(searchTimer);
    close();
    if (!typed) {
      if (end.value) input.value = end.value.label;
      return;
    }
    typed = false;
    const text = input.value.trim();
    const exact = exactPlace(text);
    if (exact) {
      choose(placeEnd(exact.id));
      return;
    }
    if (end.value && text === end.value.label) return;
    end.value = null;
    update();
    if (text) routeStatus.textContent = `Pick the ${end.noun} from the list under the box.`;
  });

  // keep focus in the box while a suggestion is tapped
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const li = event.target.closest(".place-option");
    if (!li) return;
    const option = options[Number(li.dataset.index)];
    if (option) choose(option);
  });
}

setupPicker(ends.from);
setupPicker(ends.to);

/* ---------- popular trips, swap, and the Club link in the drive ---------- */
function choosePair(fromId, toId) {
  ends.from.value = placeEnd(fromId);
  ends.to.value = placeEnd(toId);
  ends.from.input.value = ends.from.value.label;
  ends.to.input.value = ends.to.value.label;
  update();
}

for (const chip of chips) {
  const [a, b] = chip.dataset.pair.split("|");
  const r = pairFor(a, b);
  if (r) chip.querySelector(".chip-price").textContent = formatDollars(priceTrip(placeEnd(a), placeEnd(b), r).totalCents);
  chip.addEventListener("click", () => choosePair(a, b));
}

$("#swap").addEventListener("click", (event) => {
  const from = ends.from.value;
  ends.from.value = ends.to.value;
  ends.to.value = from;
  ends.from.input.value = ends.from.value ? ends.from.value.label : "";
  ends.to.input.value = ends.to.value ? ends.to.value.label : "";
  event.currentTarget.classList.toggle("is-spun");
  update();
});

for (const link of document.querySelectorAll("[data-preset]")) {
  link.addEventListener("click", () => {
    const [a, b] = link.dataset.preset.split("|");
    choosePair(a, b);
  });
}

update();

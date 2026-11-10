/* Bridger Reserve page motion: header, reveals, count-ups, tilt, and the terrain flight. */
import { formatDollars } from "./fare.js";

document.documentElement.classList.add("ready");

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const hoverable = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
const saveData = Boolean(navigator.connection && navigator.connection.saveData);
const debug = new URLSearchParams(window.location.search).has("debug");

/* header: clear at the very top, solid as soon as anything can slide under it */
const masthead = document.querySelector(".masthead");
if (masthead) {
  let solid = null;
  const sync = () => {
    const next = window.scrollY > 24;
    if (next !== solid) {
      solid = next;
      masthead.dataset.state = next ? "solid" : "top";
    }
  };
  window.addEventListener("scroll", sync, { passive: true });
  sync();
}

/* reveal on scroll */
const revealables = document.querySelectorAll("[data-reveal], .trip");
if (reduce || !("IntersectionObserver" in window)) {
  revealables.forEach((node) => node.classList.add("is-in"));
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-in");
        io.unobserve(entry.target);
      }
    },
    { threshold: 0.18, rootMargin: "0px 0px -6% 0px" },
  );
  revealables.forEach((node) => io.observe(node));
}

/* sample totals count up the first time they are read */
const sums = document.querySelectorAll(".sum[data-cents]");
const finish = (el) => {
  el.textContent = formatDollars(Number(el.dataset.cents));
};
if (reduce || !("IntersectionObserver" in window)) {
  sums.forEach(finish);
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const el = entry.target;
        io.unobserve(el);
        const end = Number(el.dataset.cents);
        const start = performance.now();
        const step = (now) => {
          const p = Math.min(1, (now - start) / 900);
          el.textContent = formatDollars(Math.round(end * (1 - (1 - p) ** 3)));
          if (p < 1) requestAnimationFrame(step);
          else finish(el);
        };
        requestAnimationFrame(step);
      }
    },
    { threshold: 0.75 },
  );
  sums.forEach((el) => io.observe(el));
}

/* the plaque and the owners card lean toward the pointer */
if (!reduce && hoverable) {
  for (const el of document.querySelectorAll("[data-tilt]")) {
    let frame = 0;
    el.addEventListener("pointermove", (event) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const r = el.getBoundingClientRect();
        const x = (event.clientX - r.left) / r.width;
        const y = (event.clientY - r.top) / r.height;
        el.style.setProperty("--ry", `${((x - 0.5) * 10).toFixed(2)}deg`);
        el.style.setProperty("--rx", `${((0.5 - y) * 8).toFixed(2)}deg`);
        el.style.setProperty("--mx", `${(x * 100).toFixed(1)}%`);
        el.style.setProperty("--my", `${(y * 100).toFixed(1)}%`);
        el.style.setProperty("--sheen", "1");
      });
    });
    el.addEventListener("pointerleave", () => {
      cancelAnimationFrame(frame);
      for (const prop of ["--rx", "--ry", "--mx", "--my", "--sheen"]) el.style.removeProperty(prop);
    });
  }
}

/* the drive: real terrain where the device can carry it, the relief image where it cannot */
const stage = document.querySelector(".flight-stage");
const canvas = document.querySelector(".flight-canvas");
const beats = [...document.querySelectorAll("[data-beat]")];
if (stage && canvas) {
  if (reduce || saveData) {
    stage.dataset.state = "static";
  } else {
    import("./terrain.js")
      .then((m) => m.startFlight({ stage, canvas, beats, debug }))
      .catch((error) => {
        stage.dataset.state = "static";
        if (debug) console.error("[flight]", error);
      });
  }
}

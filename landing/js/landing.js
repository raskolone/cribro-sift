/* Cribro Sift — ruch na stronie.
   Jedna reguła: każda animacja musi coś przesiewać. Nic nie rusza się
   dlatego, że da się poruszyć. */

const REDUCED = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
gsap.registerPlugin(ScrollTrigger);

/* ═══ 1. Sito na niebie ═══════════════════════════════════════════
   Wielki krąg z siatką stoi za nagłówkiem jak ensō. Pył opada z góry,
   dociera do płaszczyzny sita i większość się na niej zatrzymuje. */

const sky = document.getElementById("sky");
const ctx = sky.getContext("2d");
const view = { w: 0, h: 0, cx: 0, cy: 0, r: 0 };
const anim = { ring: 0, mesh: 0, dust: 0 };
const dust = [];

const GAP_A = -0.62; // przerwa w kręgu — ensō nigdy nie domyka się do końca
const GAP_B = Math.PI * 2 - 1.15;

function layout() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  sky.width = view.w * dpr;
  sky.height = view.h * dpr;
  sky.style.width = `${view.w}px`;
  sky.style.height = `${view.h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // Krąg musi zmieścić się w kadrze w całości — ucięty czyta się jak
  // przypadek, a nie jak znak. Stąd sufit na promieniu i przesunięcie
  // w prawo, w wolne pole obok nagłówka.
  view.cx = view.w * 0.63;
  view.cy = view.h * 0.45;
  view.r = Math.min(view.w * 0.25, view.h * 0.4, 330);

  const target = Math.round((view.w * view.h) / 9000);
  while (dust.length < target) dust.push(seed(true));
  dust.length = Math.min(dust.length, target);
}

function seed(anywhere) {
  return {
    x: Math.random() * view.w,
    y: anywhere ? Math.random() * view.h : -30,
    r: Math.random() * 1.2 + 0.3,
    v: 0.14 + Math.random() * 0.42,
    a: 0.14 + Math.random() * 0.44,
    // O tym, czy ziarno przejdzie, decyduje się raz — jak w życiu.
    passes: Math.random() < 0.34,
    fade: 0,
  };
}

function paint(now) {
  requestAnimationFrame(paint);
  ctx.clearRect(0, 0, view.w, view.h);

  const { cx, cy, r } = view;

  // Sito należy do hero. Gdy strona rusza dalej, krąg rozpuszcza się —
  // zrobił swoje. Zostaje sam pył, jako tło całej reszty.
  const here = Math.max(0, 1 - window.scrollY / (view.h * 0.75));
  const ring = anim.ring * here;
  const mesh = anim.mesh * here;

  /* Pył */
  for (const g of dust) {
    g.y += g.v;
    const underSieve = g.y > cy;
    const inDisc = Math.abs(g.x - cx) < r;
    if (underSieve && inDisc && !g.passes) g.fade = Math.min(1, g.fade + 0.05);
    if (g.y > view.h + 30 || g.fade >= 1) {
      Object.assign(g, seed(false));
      continue;
    }
    const alpha = g.a * (1 - g.fade) * anim.dust;
    if (alpha <= 0.002) continue;
    ctx.fillStyle = g.passes
      ? `rgba(127,227,168,${alpha.toFixed(3)})`
      : `rgba(147,167,172,${(alpha * 0.85).toFixed(3)})`;
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
    ctx.fill();
  }

  /* Wnętrze sita: światło i siatka, przycięte do kręgu */
  if (mesh > 0.002) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r - 1, 0, Math.PI * 2);
    ctx.clip();

    // Delikatna poświata, żeby krąg czytał się jak obiekt, nie jak obrys.
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    halo.addColorStop(0, `rgba(127,227,168,${(0.05 * mesh).toFixed(3)})`);
    halo.addColorStop(1, "rgba(127,227,168,0)");
    ctx.fillStyle = halo;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);

    ctx.strokeStyle = `rgba(127,227,168,${(0.115 * mesh).toFixed(3)})`;
    ctx.lineWidth = 1;
    const step = (r * 2) / 10;
    ctx.beginPath();
    for (let i = 1; i < 10; i++) {
      const o = -r + step * i;
      ctx.moveTo(cx - r, cy + o);
      ctx.lineTo(cx + r, cy + o);
      ctx.moveTo(cx + o, cy - r);
      ctx.lineTo(cx + o, cy + r);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* Obrys sita — rysuje się od przerwy, jak pociągnięcie pędzlem */
  if (ring > 0.002) {
    const end = GAP_A + (GAP_B - GAP_A) * anim.ring;
    const breath = 1 + Math.sin(now / 2600) * 0.006;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(breath, breath);
    ctx.shadowColor = `rgba(127,227,168,${(0.55 * ring).toFixed(3)})`;
    ctx.shadowBlur = 26;
    ctx.strokeStyle = `rgba(127,227,168,${(0.34 * ring).toFixed(3)})`;
    ctx.lineWidth = 1.4;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(0, 0, r, GAP_A, end);
    ctx.stroke();
    ctx.restore();
  }

  /* Płaszczyzna sita — linia, na której wszystko się rozstrzyga */
  if (mesh > 0.002) {
    const grad = ctx.createLinearGradient(cx - r * 1.9, 0, cx + r * 1.9, 0);
    grad.addColorStop(0, "rgba(127,227,168,0)");
    grad.addColorStop(0.5, `rgba(127,227,168,${(0.17 * mesh).toFixed(3)})`);
    grad.addColorStop(1, "rgba(127,227,168,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(cx - r * 1.9, cy, r * 3.8, 1);
  }
}

layout();
window.addEventListener("resize", layout);
requestAnimationFrame(paint);

/* ═══ 2. Nagłówek przesiewa sam siebie ════════════════════════════ */

const HEADLINE = [
  ["yyy", 0], ["no", 0], ["wiesz", 0], ["chciałbym", 0], ["to", 0], ["znaczy", 0],
  ["Mówić", 1], ["i", 1], ["eee", 0], ["dostawać", 1], ["dokładnie", 1], ["to,", 1],
  ["co", 1], ["miałem", 1], ["na", 1], ["myśli.", 1], ["no", 0],
];

const headline = document.getElementById("headline");
headline.innerHTML = HEADLINE.map(
  ([word, keep]) => `<span class="${keep ? "keep" : "noise"}">${word} </span>`,
).join("");

const kept = [...headline.querySelectorAll(".keep")];
const noise = [...headline.querySelectorAll(".noise")];

function siftHeadline() {
  const parent = headline.getBoundingClientRect();
  const before = new Map([...kept, ...noise].map((el) => [el, el.getBoundingClientRect()]));

  // Szum wypada z układu, ale zostaje tam, gdzie był — razem ze swoim
  // krojem, żeby nie urósł wraz z resztą.
  for (const span of noise) {
    const rect = before.get(span);
    span.style.font = getComputedStyle(span).font;
    span.style.position = "absolute";
    span.style.left = `${rect.left - parent.left}px`;
    span.style.top = `${rect.top - parent.top}px`;
  }

  headline.classList.add("sifted");

  // FLIP: ocalałe słowa wracają z dawnego miejsca i dawnego rozmiaru.
  for (const span of kept) {
    const from = before.get(span);
    const to = span.getBoundingClientRect();
    gsap.fromTo(
      span,
      {
        x: from.left - to.left,
        y: from.top - to.top,
        scale: to.width ? from.width / to.width : 1,
        color: "#5f7278",
      },
      { x: 0, y: 0, scale: 1, color: "#edf4f0", duration: 1.2, ease: "power3.inOut" },
    );
  }

  gsap.to(noise, {
    y: () => 110 + Math.random() * 220,
    x: () => (Math.random() - 0.5) * 50,
    rotation: () => (Math.random() - 0.5) * 26,
    opacity: 0,
    color: "#f5a623",
    duration: 1.6,
    ease: "power2.in",
    stagger: { each: 0.04, from: "random" },
    onComplete: () => noise.forEach((span) => span.remove()),
  });
}

/* ═══ 3. Wejście ══════════════════════════════════════════════════ */

if (REDUCED) {
  Object.assign(anim, { ring: 1, mesh: 1, dust: 1 });
  noise.forEach((span) => span.remove());
  headline.classList.add("sifted");
  gsap.set(["#heroSub", "#heroCta", "#facts", "#stage", ".reveal", "#cleanText"], { opacity: 1 });
} else {
  gsap.set(["#heroSub", "#heroCta", "#facts"], { y: 16 });
  gsap.set("#stage", { y: 46 });

  gsap
    .timeline({ delay: 0.15 })
    .to(anim, { dust: 1, duration: 1.6, ease: "power1.out" }, 0)
    .to(anim, { ring: 1, duration: 1.9, ease: "power2.inOut" }, 0.15)
    .to(anim, { mesh: 1, duration: 1.4, ease: "power1.out" }, 1.1)
    .from(headline, { opacity: 0, duration: 0.8, ease: "power2.out" }, 0.35)
    .add(siftHeadline, 1.6)
    .to("#heroSub", { opacity: 1, y: 0, duration: 0.9, ease: "power2.out" }, 2.5)
    .to("#heroCta", { opacity: 1, y: 0, duration: 0.9, ease: "power2.out" }, 2.65)
    .to("#facts", { opacity: 1, y: 0, duration: 0.9, ease: "power2.out" }, 2.8)
    .to("#stage", { opacity: 1, y: 0, duration: 1.4, ease: "power3.out" }, 2.3);
}

/* ═══ 4. Dowód: mail przed i po ═══════════════════════════════════ */

const COMPARE = [
  ["hej", 0], ["Aniu", 0], ["eee", 1], ["chciałem", 1], ["zapytać", 1], ["czy", 0],
  ["dasz", 0], ["radę", 0], ["przesłać", 0], ["mi", 0], ["ten", 1], ["raport", 0],
  ["do", 1], ["piątku", 1], ["no", 1], ["to", 1], ["znaczy", 1], ["do", 0],
  ["czwartku", 0], ["bo", 0], ["w", 0], ["piątek", 0], ["mam", 0], ["już", 1],
  ["spotkanie", 0], ["z", 0], ["klientem", 0], ["i", 0], ["yyy", 1], ["potrzebuję", 1],
  ["to", 1], ["wcześniej", 0], ["wszystko", 0], ["przejrzeć", 0], ["dzięki", 0], ["wielkie", 0],
];

document.getElementById("rawText").innerHTML = COMPARE.map(
  ([word, drop]) => `<span class="drop${drop ? " is-noise" : ""}">${word} </span>`,
).join("");

/* ═══ 5. Reakcje na przewijanie ═══════════════════════════════════ */

if (!REDUCED) {
  const nav = document.getElementById("nav");
  ScrollTrigger.create({
    start: "top -10",
    onUpdate: (self) => nav.classList.toggle("stuck", self.scroll() > 10),
  });

  gsap.utils.toArray(".reveal").forEach((el) => {
    gsap.fromTo(
      el,
      { opacity: 0, y: 22 },
      {
        opacity: 1,
        y: 0,
        duration: 1,
        ease: "power2.out",
        scrollTrigger: { trigger: el, start: "top 90%", once: true },
      },
    );
  });

  ScrollTrigger.create({
    trigger: ".panel",
    start: "top 70%",
    once: true,
    onEnter: () => {
      const words = [...document.querySelectorAll("#rawText .is-noise")];
      words.forEach((word, i) => gsap.delayedCall(i * 0.06, () => word.classList.add("out")));
      gsap.to("#cleanText", {
        opacity: 1,
        duration: 1,
        ease: "power2.out",
        delay: words.length * 0.06 + 0.4,
      });
    },
  });

  gsap.utils.toArray(".nots li").forEach((item) => {
    gsap.to(item, {
      color: "rgba(147,167,172,0.86)",
      duration: 0.9,
      scrollTrigger: { trigger: item, start: "top 82%", once: true },
    });
  });
}

/* ═══ 6. Sita w kaflach ═══════════════════════════════════════════ */

function drawMesh(canvas, density, { glow = true } = {}) {
  const c = canvas.getContext("2d");
  const size = canvas.width;
  const pad = size * 0.08;
  const r = size / 2 - pad;
  const m = size / 2;

  c.clearRect(0, 0, size, size);

  c.save();
  c.beginPath();
  c.arc(m, m, r - 1, 0, Math.PI * 2);
  c.clip();
  c.strokeStyle = "rgba(127,227,168,0.34)";
  c.lineWidth = size / 150;
  const step = (r * 2) / density;
  c.beginPath();
  for (let i = 1; i < density; i++) {
    const o = -r + step * i;
    c.moveTo(m - r, m + o);
    c.lineTo(m + r, m + o);
    c.moveTo(m + o, m - r);
    c.lineTo(m + o, m + r);
  }
  c.stroke();
  c.restore();

  if (glow) {
    c.shadowColor = "rgba(127,227,168,0.5)";
    c.shadowBlur = size / 9;
  }
  c.strokeStyle = "rgba(127,227,168,0.85)";
  c.lineWidth = size / 78;
  c.beginPath();
  c.arc(m, m, r, 0, Math.PI * 2);
  c.stroke();
}

document.querySelectorAll(".mesh canvas").forEach((canvas) => {
  const dpr = 2;
  const css = canvas.width / dpr;
  canvas.style.width = `${css}px`;
  canvas.style.height = `${css}px`;
  drawMesh(canvas, Number(canvas.dataset.density));
});

/* ═══ 7. Pierścień HUD-a i jego trzy stany ════════════════════════ */

function ringPainter(canvas, state) {
  const c = canvas.getContext("2d");
  const size = canvas.width;
  const m = size / 2;
  const scale = size / 44;
  const grains = Array.from({ length: 16 }, () => ({
    a: Math.random() * Math.PI * 2,
    r: 3 + Math.random() * 9,
    v: 0.14 + Math.random() * 0.26,
    keep: Math.random() > 0.45,
  }));

  return function frame(t, level) {
    c.clearRect(0, 0, size, size);
    c.save();
    c.scale(scale, scale);
    const cm = 22;

    if (state === "listening") {
      for (let i = 0; i < 36; i++) {
        const angle = (i / 36) * Math.PI * 2 - Math.PI / 2;
        const wob = Math.sin(t * 2.4 + i * 0.6) * 0.5 + 0.5;
        const inner = 12.5;
        const outer = inner + 1.6 + level * 6.4 * (0.4 + wob * 0.6);
        c.strokeStyle = `rgba(127,227,168,${0.2 + level * 0.62 * (0.35 + wob * 0.65)})`;
        c.lineWidth = 1.3;
        c.lineCap = "round";
        c.beginPath();
        c.moveTo(cm + Math.cos(angle) * inner, cm + Math.sin(angle) * inner);
        c.lineTo(cm + Math.cos(angle) * outer, cm + Math.sin(angle) * outer);
        c.stroke();
      }
      c.strokeStyle = `rgba(127,227,168,${0.5 + level * 0.4})`;
      c.lineWidth = 1.2;
      c.beginPath();
      c.arc(cm, cm, 10, 0, Math.PI * 2);
      c.stroke();
    } else if (state === "sifting") {
      c.strokeStyle = "rgba(245,166,35,0.55)";
      c.lineWidth = 1.1;
      c.beginPath();
      c.arc(cm, cm, 11.5, 0, Math.PI * 2);
      c.stroke();
      for (const g of grains) {
        g.r += g.v;
        const passed = g.r > 11.5;
        if (g.r > 19) {
          g.r = 2;
          g.a = Math.random() * Math.PI * 2;
          g.keep = Math.random() > 0.45;
        }
        if (passed && !g.keep) continue;
        c.fillStyle = passed ? "rgba(127,227,168,0.92)" : "rgba(245,166,35,0.6)";
        c.beginPath();
        c.arc(cm + Math.cos(g.a) * g.r, cm + Math.sin(g.a) * g.r, passed ? 1.4 : 1, 0, Math.PI * 2);
        c.fill();
      }
    } else {
      c.strokeStyle = "rgba(127,227,168,0.95)";
      c.lineWidth = 1.5;
      c.lineCap = "round";
      c.beginPath();
      c.arc(cm, cm, 11.5, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(cm - 4.6, cm);
      c.lineTo(cm - 1.4, cm + 3.3);
      c.lineTo(cm + 5.2, cm - 3.8);
      c.stroke();
    }
    c.restore();
  };
}

const painters = [];
const hudRing = document.getElementById("hudRing");
if (hudRing) painters.push(ringPainter(hudRing, "listening"));
document.querySelectorAll(".step__pill canvas").forEach((canvas) => {
  painters.push(ringPainter(canvas, canvas.dataset.state));
});

const waveBars = [];
const wave = document.getElementById("hudWave");
if (wave) {
  for (let i = 0; i < 26; i++) {
    const bar = document.createElement("i");
    wave.appendChild(bar);
    waveBars.push(bar);
  }
}

/* Udawany poziom głosu — nieregularny, żeby nie wyglądał jak metronom. */
function tick(now) {
  requestAnimationFrame(tick);
  const t = now / 1000;
  const level = REDUCED
    ? 0.4
    : 0.34 + Math.sin(t * 2.1) * 0.2 + Math.sin(t * 5.7) * 0.13 + Math.sin(t * 11.3) * 0.06;

  for (const painter of painters) painter(t, Math.max(0.08, level));

  waveBars.forEach((bar, i) => {
    const wob = Math.sin(t * 6 + i * 0.62) * 0.5 + 0.5;
    bar.style.transform = `scaleY(${(1 + level * 9 * (0.22 + wob * 0.78)).toFixed(2)})`;
    bar.style.opacity = (0.26 + level * 0.7 * (0.3 + wob * 0.7)).toFixed(2);
  });
}
requestAnimationFrame(tick);

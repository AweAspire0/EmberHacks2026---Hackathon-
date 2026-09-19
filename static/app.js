/* Paper Machine - renders and executes the graph Gemini compiles from a drawing. */

const $ = (id) => document.getElementById(id);

const SAMPLE = {
  title: "Turnstile",
  kind: "state_machine",
  nodes: [
    { id: "locked",   label: "Locked",       type: "start", x: 0.18, y: 0.30 },
    { id: "unlocked", label: "Unlocked",     type: "state", x: 0.78, y: 0.30 },
    { id: "fault",    label: "Out of order", type: "end",   x: 0.48, y: 0.85 },
  ],
  edges: [
    { from: "locked",   to: "unlocked", label: "coin" },
    { from: "unlocked", to: "locked",   label: "push" },
    { from: "locked",   to: "locked",   label: "push" },
    { from: "unlocked", to: "unlocked", label: "coin" },
    { from: "unlocked", to: "fault",    label: "jam" },
  ],
  warnings: [],
  sample: true,
};

const state = {
  graph: null,
  layout: new Map(),
  currentId: null,
  token: null,      // { edge, t0, to, path }
  autoTimer: null,
  pendingFile: null,
  stream: null,
};

/* -- canvas --------------------------------------------------------- */

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  computeLayout();
}
new ResizeObserver(resize).observe(canvas);

/* Map normalized drawing coords onto the canvas, rescaled to fill it. */
function computeLayout() {
  state.layout.clear();
  if (!state.graph) return;

  const nodes = state.graph.nodes;
  const rect = canvas.getBoundingClientRect();
  const padX = 80, padTop = 105, padBottom = 70;  // extra room on top for self-loops
  const w = Math.max(1, rect.width - padX * 2);
  const h = Math.max(1, rect.height - padTop - padBottom);

  const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX, spanY = maxY - minY;

  nodes.forEach((node, i) => {
    let px, py;
    if (spanX < 0.02 && spanY < 0.02) {
      // Degenerate coords - fall back to a circle so it is still readable.
      const a = (i / nodes.length) * Math.PI * 2 - Math.PI / 2;
      px = padX + w / 2 + Math.cos(a) * (Math.min(w, h) / 2.6);
      py = padTop + h / 2 + Math.sin(a) * (Math.min(w, h) / 2.6);
    } else {
      px = padX + (spanX < 0.02 ? 0.5 : (node.x - minX) / spanX) * w;
      py = padTop + (spanY < 0.02 ? 0.5 : (node.y - minY) / spanY) * h;
    }

    ctx.font = "500 14px ui-sans-serif, system-ui, sans-serif";
    const textW = ctx.measureText(node.label).width;
    const bw = Math.max(node.type === "decision" ? 120 : 96, textW + 40);
    const bh = node.type === "decision" ? 66 : 46;
    state.layout.set(node.id, { x: px, y: py, w: bw, h: bh, node });
  });

  // Separating and clamping fight each other, so alternate until both hold.
  for (let i = 0; i < 4; i++) {
    nudgeApart();
    clampInside(rect);
  }
}

/* Keep every box on screen, with headroom above for self-loops. */
function clampInside(rect) {
  state.layout.forEach((b) => {
    const hasLoop = (state.graph.edges || []).some((e) => e.from === b.node.id && e.to === b.node.id);
    const top = b.h / 2 + 10 + (hasLoop ? 58 : 0);
    b.x = Math.min(rect.width - b.w / 2 - 10, Math.max(b.w / 2 + 10, b.x));
    b.y = Math.min(rect.height - b.h / 2 - 10, Math.max(top, b.y));
  });
}

/* Gemini's coordinates are approximate; push overlapping boxes apart. */
function nudgeApart() {
  const boxes = [...state.layout.values()];
  for (let pass = 0; pass < 60; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const minX = (a.w + b.w) / 2 + 30, minY = (a.h + b.h) / 2 + 34;
        if (Math.abs(dx) < minX && Math.abs(dy) < minY) {
          const pushX = (minX - Math.abs(dx)) / 2, pushY = (minY - Math.abs(dy)) / 2;
          if (pushX < pushY) {
            const s = dx === 0 ? 1 : Math.sign(dx);
            a.x -= s * pushX; b.x += s * pushX;
          } else {
            const s = dy === 0 ? 1 : Math.sign(dy);
            a.y -= s * pushY; b.y += s * pushY;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
}

/* -- geometry ------------------------------------------------------- */

const quad = (p0, p1, p2, t) => ({
  x: (1 - t) ** 2 * p0.x + 2 * (1 - t) * t * p1.x + t ** 2 * p2.x,
  y: (1 - t) ** 2 * p0.y + 2 * (1 - t) * t * p1.y + t ** 2 * p2.y,
});

/* Where a ray leaving `box` toward (tx,ty) crosses the box edge. */
function boundary(box, tx, ty) {
  const dx = tx - box.x, dy = ty - box.y;
  if (dx === 0 && dy === 0) return { x: box.x, y: box.y };
  const hw = box.w / 2 + 4, hh = box.h / 2 + 4;
  const scale = Math.min(
    dx === 0 ? Infinity : hw / Math.abs(dx),
    dy === 0 ? Infinity : hh / Math.abs(dy)
  );
  return { x: box.x + dx * scale, y: box.y + dy * scale };
}

function edgePath(edge, index, total) {
  const a = state.layout.get(edge.from), b = state.layout.get(edge.to);
  if (!a || !b) return null;

  if (edge.from === edge.to) {
    const r = 38;
    // Loop above the node, unless it would run off the top of the canvas.
    const above = a.y - a.h / 2 - r * 1.6 > 4;
    return {
      selfLoop: true,
      cx: a.x,
      cy: above ? a.y - a.h / 2 - r * 0.55 : a.y + a.h / 2 + r * 0.55,
      r,
      below: !above,
    };
  }

  const p0 = boundary(a, b.x, b.y);
  const p2 = boundary(b, a.x, a.y);
  const mx = (p0.x + p2.x) / 2, my = (p0.y + p2.y) / 2;
  const dx = p2.x - p0.x, dy = p2.y - p0.y;
  const len = Math.hypot(dx, dy) || 1;

  // Fan parallel edges apart; bend everything slightly so labels never collide.
  const offset = (total > 1 ? (index - (total - 1) / 2) * 46 : 0) + 26;
  const p1 = { x: mx + (-dy / len) * offset, y: my + (dx / len) * offset };
  return { selfLoop: false, p0, p1, p2 };
}

function pointOn(path, t) {
  if (path.selfLoop) {
    const a = Math.PI * 0.75 + t * Math.PI * 1.5;
    const dy = Math.sin(a) * path.r;
    return { x: path.cx + Math.cos(a) * path.r, y: path.cy + (path.below ? -dy : dy) };
  }
  return quad(path.p0, path.p1, path.p2, t);
}

/* -- drawing -------------------------------------------------------- */

const COLORS = {
  start: "#34d399", state: "#a3a3a3", decision: "#fbbf24", action: "#60a5fa", end: "#f87171",
};

function groupedEdges() {
  const groups = new Map();
  (state.graph?.edges || []).forEach((e) => {
    const key = [e.from, e.to].sort().join("::");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  });
  return groups;
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, rect.width, rect.height);
  if (!state.graph) return requestAnimationFrame(draw);

  const now = performance.now();

  groupedEdges().forEach((group) => {
    group.forEach((edge, i) => {
      const path = edgePath(edge, i, group.length);
      if (!path) return;
      edge._path = path;

      const live = state.currentId === edge.from && !state.token;
      const stroke = live ? "rgba(52,211,153,.75)" : "rgba(115,115,115,.45)";
      ctx.strokeStyle = stroke;
      ctx.lineWidth = live ? 2 : 1.5;

      ctx.beginPath();
      if (path.selfLoop) {
        // Sample the same function the token travels along, so they never diverge.
        for (let s = 0; s <= 32; s++) {
          const p = pointOn(path, s / 32);
          s ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
        }
      } else {
        ctx.moveTo(path.p0.x, path.p0.y);
        ctx.quadraticCurveTo(path.p1.x, path.p1.y, path.p2.x, path.p2.y);
      }
      ctx.stroke();

      arrowHead(pointOn(path, 1), pointOn(path, 0.94), stroke);

      if (edge.label) {
        const at = pointOn(path, 0.5);
        labelPill(edge.label, at.x, at.y, live);
      }
    });
  });

  state.layout.forEach((box) => {
    const { node } = box;
    const active = node.id === state.currentId;
    const color = COLORS[node.type] || COLORS.state;

    if (active) {
      const pulse = 0.5 + 0.5 * Math.sin(now / 420);
      ctx.shadowColor = color;
      ctx.shadowBlur = 16 + pulse * 14;
    }
    ctx.fillStyle = active ? "rgba(6,78,59,.55)" : "rgba(23,23,23,.9)";
    ctx.strokeStyle = active ? color : "rgba(82,82,82,.9)";
    ctx.lineWidth = active ? 2.5 : 1.5;

    shape(node.type, box);
    ctx.fill();
    ctx.stroke();
    ctx.shadowBlur = 0;

    if (node.type === "end") {   // double ring, as drawn on paper
      ctx.lineWidth = 1.2;
      shape("end", { ...box, w: box.w - 12, h: box.h - 12 });
      ctx.stroke();
    }

    ctx.fillStyle = active ? "#ecfdf5" : "#e5e5e5";
    ctx.font = "500 14px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(node.label, box.x, box.y);
  });

  if (state.token) {
    const p = Math.min(1, (now - state.token.t0) / 700);
    const eased = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
    const at = pointOn(state.token.path, eased);
    ctx.shadowColor = "#34d399";
    ctx.shadowBlur = 22;
    ctx.fillStyle = "#6ee7b7";
    ctx.beginPath();
    ctx.arc(at.x, at.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    if (p >= 1) {
      state.currentId = state.token.to;
      state.token = null;
      afterMove();
    }
  }

  requestAnimationFrame(draw);
}

function shape(type, box) {
  const { x, y, w, h } = box;
  ctx.beginPath();
  if (type === "start" || type === "end") {
    ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
  } else if (type === "decision") {
    ctx.moveTo(x, y - h / 2); ctx.lineTo(x + w / 2, y);
    ctx.lineTo(x, y + h / 2); ctx.lineTo(x - w / 2, y);
    ctx.closePath();
  } else {
    ctx.roundRect(x - w / 2, y - h / 2, w, h, type === "action" ? 4 : 12);
  }
}

function arrowHead(tip, before, color) {
  const a = Math.atan2(tip.y - before.y, tip.x - before.x);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - 10 * Math.cos(a - 0.4), tip.y - 10 * Math.sin(a - 0.4));
  ctx.lineTo(tip.x - 10 * Math.cos(a + 0.4), tip.y - 10 * Math.sin(a + 0.4));
  ctx.closePath();
  ctx.fill();
}

function labelPill(text, x, y, live) {
  ctx.font = "500 12px ui-monospace, monospace";
  const w = ctx.measureText(text).width + 14;
  ctx.fillStyle = "#0a0a0a";
  ctx.strokeStyle = live ? "rgba(52,211,153,.5)" : "rgba(82,82,82,.6)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x - w / 2, y - 10, w, 20, 10);
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = live ? "#6ee7b7" : "#a3a3a3";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y);
}

/* -- execution ------------------------------------------------------ */

function outgoing() {
  if (!state.graph || !state.currentId) return [];
  return state.graph.edges.filter((e) => e.from === state.currentId);
}

function fire(edge) {
  if (state.token) return;
  const path = edge._path || edgePath(edge, 0, 1);
  if (!path) return;
  state.token = { edge, path, to: edge.to, t0: performance.now() };
  const to = state.graph.nodes.find((n) => n.id === edge.to);
  log((edge.label || "(unlabelled)") + " -> " + (to ? to.label : edge.to));
  renderTransitions(true);
}

function afterMove() {
  const node = state.graph.nodes.find((n) => n.id === state.currentId);
  $("current-state").textContent = node ? node.label : "-";
  renderTransitions();
  if (node && node.type === "end") stopAuto("reached an end state");
}

function renderTransitions(disabled = false) {
  const host = $("transitions");
  host.innerHTML = "";
  const edges = outgoing();

  if (!edges.length) {
    host.innerHTML = '<p class="text-sm text-neutral-600">No arrows lead out of this state - the machine has halted.</p>';
    return;
  }
  edges.forEach((edge, i) => {
    const to = state.graph.nodes.find((n) => n.id === edge.to);
    const btn = document.createElement("button");
    btn.className = "btn btn-event";
    btn.disabled = disabled;
    btn.innerHTML =
      '<span class="mr-1.5 font-mono text-[10px] text-neutral-500">' + (i + 1) + "</span>" +
      escapeHtml(edge.label || "(unlabelled)") +
      '<span class="ml-1.5 text-neutral-500">to ' + escapeHtml(to ? to.label : edge.to) + "</span>";
    btn.onclick = () => fire(edge);
    host.appendChild(btn);
  });
}

function log(text) {
  const li = document.createElement("li");
  li.textContent = text;
  li.className = "text-neutral-400";
  $("trace").appendChild(li);
  $("trace").scrollTop = $("trace").scrollHeight;
}

function loadGraph(graph) {
  state.graph = graph;
  state.token = null;
  stopAuto();
  const start = graph.nodes.find((n) => n.type === "start") || graph.nodes[0];
  state.currentId = start.id;

  $("machine-title").innerHTML = escapeHtml(graph.title) +
    (graph.sample ? ' <span class="text-sm text-neutral-500">(sample)</span>' : "");
  $("trace").innerHTML = "";
  log("start: " + start.label);

  const warn = graph.warnings || [];
  $("warnings-card").classList.toggle("hidden", warn.length === 0);
  $("warnings").innerHTML = warn.map((w) => "<li>- " + escapeHtml(w) + "</li>").join("");

  resize();
  afterMove();
}

function reset() {
  if (state.graph) loadGraph(state.graph);
}

function stopAuto(reason) {
  if (state.autoTimer) {
    clearInterval(state.autoTimer);
    state.autoTimer = null;
    $("btn-auto").textContent = "Auto-run";
    if (reason) log("stopped: " + reason);
  }
}

function toggleAuto() {
  if (state.autoTimer) return stopAuto("paused");
  $("btn-auto").textContent = "Stop";
  state.autoTimer = setInterval(() => {
    const edges = outgoing();
    if (!edges.length) return stopAuto("no way out");
    if (!state.token) fire(edges[Math.floor(Math.random() * edges.length)]);
  }, 1400);
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* -- capture + compile ---------------------------------------------- */

function setStatus(text, tone = "neutral") {
  const el = $("status");
  el.textContent = text;
  el.className = "mt-2 min-h-[1.25rem] text-xs " +
    { neutral: "text-neutral-500", busy: "text-emerald-400", error: "text-red-400" }[tone];
}

async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
    });
    $("video").srcObject = state.stream;
    await $("video").play();
    $("camera-wrap").classList.remove("hidden");
    $("preview").classList.add("hidden");
    $("btn-shoot").classList.remove("hidden");
    $("btn-camera").classList.add("hidden");
    setStatus("Fill the frame with the drawing, then capture.");
  } catch (err) {
    setStatus("Camera unavailable (" + err.name + "). Use Upload photo instead.", "error");
  }
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
  state.stream = null;
  $("camera-wrap").classList.add("hidden");
  $("btn-shoot").classList.add("hidden");
  $("btn-camera").classList.remove("hidden");
}

function shoot() {
  const video = $("video");
  const c = document.createElement("canvas");
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext("2d").drawImage(video, 0, 0);
  c.toBlob((blob) => { usePhoto(blob); stopCamera(); }, "image/jpeg", 0.92);
}

/* Phone photos are ~4000px and several MB. Gemini does not need that to read a
   pen drawing, and the upload plus the extra pixels cost real seconds. */
async function shrink(blob, maxEdge = 1400) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && blob.size < 900_000) return blob;

  const c = document.createElement("canvas");
  c.width = Math.round(bitmap.width * scale);
  c.height = Math.round(bitmap.height * scale);
  c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
  bitmap.close?.();

  const out = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
  return out && out.size < blob.size ? out : blob;
}

async function usePhoto(blob) {
  setStatus("Preparing image…");
  const before = blob.size;
  // HEIC and other exotic formats may not decode here — fall back to the original.
  const ready = await shrink(blob).catch(() => blob);

  state.pendingFile = ready;
  $("preview").src = URL.createObjectURL(ready);
  $("preview").classList.remove("hidden");
  $("btn-compile").disabled = false;

  const kb = (n) => Math.round(n / 1024) + "kB";
  setStatus(ready.size < before
    ? `Ready to compile (${kb(before)} → ${kb(ready.size)}).`
    : "Ready to compile.");
}

async function compile() {
  if (!state.pendingFile) return;
  $("btn-compile").disabled = true;

  const body = new FormData();
  body.append("image", state.pendingFile, "drawing.jpg");
  body.append("hint", $("hint").value);

  // A silent 30-second wait feels broken. Count up, and say why it is slow.
  const started = Date.now();
  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - started) / 1000);
    setStatus("Gemini is reading the drawing... " + s + "s" +
      (s > 10 ? " (API is busy - retrying across models)" : ""), "busy");
  }, 250);

  try {
    const res = await fetch("/api/compile", { method: "POST", body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    loadGraph(data);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    setStatus("Compiled " + data.nodes.length + " states and " + data.edges.length +
      " transitions in " + secs + "s on " + data.model + ".");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    clearInterval(ticker);
    $("btn-compile").disabled = false;
  }
}

/* -- wiring --------------------------------------------------------- */

$("btn-camera").onclick = startCamera;
$("btn-shoot").onclick = shoot;
$("btn-compile").onclick = compile;
$("btn-reset").onclick = reset;
$("btn-auto").onclick = toggleAuto;
$("btn-sample").onclick = () => loadGraph(structuredClone(SAMPLE));
$("file-input").onchange = (e) => {
  if (e.target.files[0]) { stopCamera(); usePhoto(e.target.files[0]); }
};

document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  const n = parseInt(e.key, 10);
  if (n >= 1 && n <= 9) {
    const edge = outgoing()[n - 1];
    if (edge) fire(edge);
  }
});

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => { $("model-badge").textContent = h.model ? "model: " + h.model : "no API key"; })
  .catch(() => { $("model-badge").textContent = "offline"; });

loadGraph(structuredClone(SAMPLE));
requestAnimationFrame(draw);

const $ = (id) => document.getElementById(id);
const log = $("log");
const promptEl = $("prompt");
const pct = (x) => `${Math.round(x * 100)}%`;

let port;
let running = false;
let stepEl = null;
const confirmEls = new Map();
const askEls = new Map();

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

function scrollDown() { const m = $("main"); m.scrollTop = m.scrollHeight; }

function setRunning(v) {
  running = v;
  $("run").hidden = v;
  $("stop").hidden = !v;
  promptEl.disabled = v;
  $("status").textContent = v ? "working" : "";
  $("status").classList.toggle("live", v);
}

function meter(entries, warn) {
  const m = h("div", { class: "meter" + (warn ? " warn" : ""), role: "img" });
  const total = entries.reduce((s, e) => s + e.p, 0) || 1;
  for (const e of entries) {
    if (e.p <= 0.005) continue;
    m.append(h("span", { style: `width:${(e.p / total) * 100}%` }));
  }
  return m;
}

function render(ev) {
  switch (ev.type) {
    case "run-start":
      $("empty").hidden = true;
      log.replaceChildren(h("p", { class: "goal", text: ev.goal }));
      stepEl = null;
      setRunning(true);
      break;

    case "brief": {
      const b = ev.brief || {};
      const box = h("details", { class: "shot" }, h("summary", { text: "Plan" }), h("p", { class: "line", text: b.task || "" }));
      if (Array.isArray(b.steps)) {
        const ol = h("ol", { class: "line" });
        for (const x of b.steps) ol.append(h("li", { text: String(x) }));
        box.append(ol);
      }
      if (b.stop_at) box.append(h("p", { class: "line muted", text: `Stops: ${b.stop_at}` }));
      log.append(box);
      break;
    }

    case "step":
      stepEl?.classList.add("finished");
      stepEl = h("section", { class: "step" }, h("span", { class: "step-n" }), h("h3", { text: `Step ${ev.step}` }));
      log.append(stepEl);
      break;

    case "observe": {
      const where = ev.restricted ? `${ev.title || ev.url} (can't read this page)` : `${ev.title || ev.url}, ${ev.elements} elements in view`;
      stepEl?.append(h("p", { class: "line muted", text: `Looking at ${where}` }));
      if (ev.thumb) {
        stepEl?.append(h("details", { class: "shot" }, h("summary", { text: "Screenshot sent to Jev" }), h("img", { src: ev.thumb, alt: "Screenshot of the page with element ids" })));
      }
      break;
    }

    case "plan": {
      const p = ev.plan;
      if (p.thought) stepEl?.append(h("p", { class: "line thought", text: p.thought }));
      if (p.action !== "done" && p.action !== "fail" && p.action !== "ask_user" && p.action !== "handoff") {
        const what = p.action === "navigate" ? p.url
          : p.action === "type" ? `"${p.text || ""}" into ${p.target}`
          : p.action === "select" ? `"${p.text || ""}" in ${p.target}`
          : p.action === "scroll" ? (p.direction || "down")
          : p.action === "press_key" ? p.key
          : p.action === "fill" ? (p.fields || []).map((f) => `${f.element_hint}="${f.value}"`).join(", ")
          : p.target || "";
        stepEl?.append(h("p", { class: "line act" }, h("span", { class: "verb", text: p.action.replace("_", " ") }), what || ""));
      }
      break;
    }

    case "ground": {
      const box = h("div", { class: "jev" });
      if (ev.method?.startsWith("choice") && ev.top?.length) {
        const top = ev.top[0];
        const low = ev.confidence != null && !ev.target;
        box.append(
          h("div", { class: "jev-head" },
            h("span", {}, h("b", { text: "Jev picked " }), top.id === "none" ? "none of the elements" : top.id),
            h("span", { class: "muted", text: `${pct(ev.confidence)} confident` })),
          meter(ev.top, low)
        );
        const alts = h("ul", { class: "alts" });
        for (const t of ev.top) alts.append(h("li", {}, h("span", { text: `${t.id} ${t.label}` }), h("span", { text: pct(t.p) })));
        box.append(alts);
      }
      if (ev.box) {
        box.append(h("div", { class: "jev-head", style: "margin-top:8px" },
          h("span", {}, h("b", { text: "Located on screen" })),
          h("span", { class: "muted", text: `${pct(ev.box.confidence)} confident` })));
        box.append(meter([{ p: ev.box.confidence }, { p: 1 - ev.box.confidence }], ev.box.confidence < 0.5));
      }
      if (ev.target) box.append(h("p", { class: "line", text: `Target: ${ev.target.label}` }));
      else box.append(h("p", { class: "line err", text: "No element was a confident match." }));
      if (ev.risky != null) box.append(h("p", { class: "line muted", text: `Hard to undo: ${pct(ev.risky)}` }));
      if (ev.note) box.append(h("p", { class: "line muted", text: ev.note }));
      stepEl?.append(box);
      break;
    }

    case "confirm": {
      const card = h("div", { class: "confirm" },
        h("p", {}, h("b", { text: ev.summary }), document.createElement("br"),
          `Jev rates this ${pct(ev.probability)} likely to be hard to undo.`),
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "Allow this action", onclick: () => answer(ev.id, true) }),
          h("button", { class: "btn danger", type: "button", text: "Stop task", onclick: () => answer(ev.id, false) })));
      confirmEls.set(ev.id, card);
      stepEl?.append(card);
      break;
    }

    case "ask": {
      const input = h("input", { type: "text", class: "reply", placeholder: "Optional note for the agent" });
      const done = () => port.postMessage({ type: "answer", id: ev.id, reply: input.value.trim() });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(); } });
      const card = h("div", { class: "confirm" },
        h("p", {}, h("b", { text: "Your turn" }), document.createElement("br"), ev.question),
        ev.auto ? null : input,
        h("div", { class: "row" },
          h("button", { class: "btn primary", type: "button", text: "Continue", onclick: done }),
          h("button", { class: "btn danger", type: "button", text: "Stop task", onclick: () => port.postMessage({ type: "stop" }) })));
      askEls.set(ev.id, card);
      stepEl?.append(card);
      break;
    }

    case "ask-resolved": {
      const card = askEls.get(ev.id);
      const auto = typeof ev.reply === "string" && ev.reply.startsWith("\u0000");
      if (card) card.replaceWith(h("p", { class: "line " + (ev.reply != null ? "okc" : "err"), text: ev.reply == null ? "Stopped." : auto ? "Done, carrying on." : `You continued${ev.reply ? `: ${ev.reply}` : "."}` }));
      askEls.delete(ev.id);
      break;
    }

    case "confirm-resolved": {
      const card = confirmEls.get(ev.id);
      if (card) card.replaceWith(h("p", { class: "line " + (ev.approve ? "okc" : "err"), text: ev.approve ? "You allowed this action." : "You stopped the task." }));
      confirmEls.delete(ev.id);
      break;
    }

    case "act":
      stepEl?.append(h("p", { class: "line " + (ev.ok ? "okc" : "err"), text: ev.ok ? ev.detail : `Failed: ${ev.detail}` }));
      break;

    case "verify":
      if (ev.probability != null) stepEl?.append(h("p", { class: "line muted", text: `Jev rates the goal complete: ${pct(ev.probability)}` }));
      break;

    case "run-end": {
      const good = ev.status === "done" || ev.status === "handoff";
      stepEl?.classList.add(good ? "finished" : "failed");
      const titles = { done: "Done", handoff: "Over to you", failed: "Couldn't finish", stopped: "Stopped", error: "Something went wrong", "max-steps": "Step limit reached" };
      log.append(h("section", { class: "result" },
        h("h3", { class: good ? "" : "err", text: titles[ev.status] || ev.status }),
        h("p", { text: ev.answer || "" })));
      setRunning(false);
      promptEl.focus();
      break;
    }

    case "error":
      log.append(h("p", { class: "line err", text: ev.message }));
      break;
  }
  scrollDown();
}

function answer(id, approve) { port.postMessage({ type: "confirm", id, approve }); }

function connect() {
  port = chrome.runtime.connect({ name: "panel" });
  port.onMessage.addListener((ev) => {
    if (ev.type === "replay") {
      if (ev.events.length) { $("empty").hidden = true; ev.events.forEach(render); }
      setRunning(ev.running);
      return;
    }
    render(ev);
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 500));
}

async function start() {
  const prompt = promptEl.value.trim();
  if (!prompt || running) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return render({ type: "error", message: "No active tab to work in." });
  port.postMessage({ type: "start", prompt, tabId: tab.id });
  promptEl.value = "";
}

async function checkKeys() {
  const { typesafeKey, deepseekKey } = await chrome.storage.local.get(["typesafeKey", "deepseekKey"]);
  const missing = !typesafeKey || !deepseekKey;
  $("setup").hidden = !missing;
  $("run").disabled = missing;
}

$("composer").addEventListener("submit", (e) => { e.preventDefault(); start(); });
promptEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); }
});
$("stop").addEventListener("click", () => port.postMessage({ type: "stop" }));
$("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("openSettings").addEventListener("click", () => chrome.runtime.openOptionsPage());
chrome.storage.onChanged.addListener(checkKeys);

connect();
checkKeys();
promptEl.focus();

import { DEFAULTS, getSettings, saveSettings } from "./lib/settings.js";
import { testTypeSafe } from "./lib/typesafe.js";
import { testDeepSeek, testCerebras } from "./lib/deepseek.js";

const $ = (id) => document.getElementById(id);
const KEYS = Object.keys(DEFAULTS);

function fill(s) {
  for (const k of KEYS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!s[k];
    else el.value = s[k];
  }
}

/** Reads the form, so tests use what's typed even before saving. */
function read() {
  const out = {};
  for (const k of KEYS) {
    const el = $(k);
    if (!el) continue;
    if (el.type === "checkbox") out[k] = el.checked;
    else if (el.type === "number") {
      const n = Number(el.value);
      out[k] = Number.isFinite(n) && el.value !== "" ? n : DEFAULTS[k];
    } else out[k] = el.value.trim();
  }
  out.maxSteps = Math.max(1, Math.min(100, Math.round(out.maxSteps)));
  for (const k of ["choiceThreshold", "boxThreshold", "riskThreshold"]) out[k] = Math.max(0, Math.min(1, out[k]));
  for (const k of ["typesafeBase", "deepseekBase", "jevModel", "boxModel", "deepseekModel", "cerebrasBase", "cerebrasModel"]) if (!out[k]) out[k] = DEFAULTS[k];
  return out;
}

let savedTimer;
function flash(msg) {
  $("saved").textContent = msg;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => ($("saved").textContent = ""), 2500);
}

function showResults(listId, rows) {
  const ul = $(listId);
  ul.replaceChildren(...rows.map((r) => {
    const li = document.createElement("li");
    const mark = document.createElement("span");
    mark.className = r.ok ? "ok" : "bad";
    mark.textContent = r.ok ? "✓" : "✕";
    mark.setAttribute("aria-label", r.ok ? "passed" : "failed");
    const name = document.createElement("b");
    name.textContent = r.name;
    const detail = document.createElement("span");
    detail.textContent = r.detail;
    li.append(mark, name, detail);
    return li;
  }));
}

async function runTest(button, listId, fn, missingKey, label) {
  const cfg = read();
  if (!cfg[missingKey]) return showResults(listId, [{ name: "Key", ok: false, detail: `Enter your ${label} API key first.` }]);
  const text = button.textContent;
  button.disabled = true;
  button.textContent = "Testing…";
  $(listId).replaceChildren();
  try {
    showResults(listId, await fn(cfg));
  } catch (e) {
    showResults(listId, [{ name: "Error", ok: false, detail: e.message }]);
  } finally {
    button.disabled = false;
    button.textContent = text;
  }
}

$("testTypeSafe").addEventListener("click", (e) => runTest(e.currentTarget, "tsResults", testTypeSafe, "typesafeKey", "TypeSafe"));
$("testDeepSeek").addEventListener("click", (e) => runTest(e.currentTarget, "dsResults", testDeepSeek, "deepseekKey", "DeepSeek"));
$("testCerebras").addEventListener("click", (e) => runTest(e.currentTarget, "cbResults", testCerebras, "cerebrasKey", "Cerebras"));

document.querySelectorAll("[data-reveal]").forEach((b) => {
  b.addEventListener("click", () => {
    const input = $(b.dataset.reveal);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    b.textContent = show ? "Hide" : "Show";
  });
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const s = read();
  await saveSettings(s);
  fill(s);
  flash("Settings saved");
});

$("reset").addEventListener("click", () => {
  const keep = { typesafeKey: $("typesafeKey").value.trim(), deepseekKey: $("deepseekKey").value.trim(), cerebrasKey: $("cerebrasKey").value.trim() };
  fill({ ...DEFAULTS, ...keep });
  flash("Defaults restored. Save to keep them.");
});

fill(await getSettings());

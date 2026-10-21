// Planner models over the OpenAI-compatible Chat Completions API: DeepSeek or Cerebras (Qwen).
import { makeTestImage } from "./image.js";

/**
 * @param {{deepseekKey:string, deepseekBase?:string, deepseekModel:string}} cfg
 * @param {Array<{role:string, content:any}>} messages
 * @param {{json?:boolean, maxTokens?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{content:string, model:string}>}
 */
export const PLANNERS = { deepseek: "DeepSeek", cerebras: "Cerebras Qwen" };

/** Key, address and model of the planner picked in the side panel. */
export function planner(cfg) {
  if (cfg.planner === "cerebras") {
    return { id: "cerebras", name: "Cerebras", key: cfg.cerebrasKey, base: cfg.cerebrasBase || "https://api.cerebras.ai/v1", model: cfg.cerebrasModel || "qwen-3.8-27b", vision: false };
  }
  return { id: "deepseek", name: "DeepSeek", key: cfg.deepseekKey, base: cfg.deepseekBase || "https://api.deepseek.com", model: cfg.deepseekModel, vision: !!cfg.deepseekVision };
}

export async function chat(cfg, messages, { json = true, maxTokens = 8000, signal } = {}) {
  const p = planner(cfg);
  if (!p.key) throw new Error(`${p.name} API key is missing. Add it in Settings.`);
  const base = p.base.replace(/\/+$/, "");
  const body = {
    model: p.model,
    messages,
    temperature: 0.2,
    max_tokens: maxTokens,
    stream: false
  };
  // deepseek-flash thinks before answering and the thinking counts against max_tokens;
  // with a long page prompt and a small budget the answer came back empty.
  if (p.id === "deepseek") body.reasoning_effort = cfg.deepseekEffort || "low";
  if (json) body.response_format = { type: "json_object" };

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${p.key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal
    });
    if (res.ok) {
      const data = await res.json();
      // Qwen and other thinking models may put their reasoning in <think> tags before the answer.
      const content = String(data.choices?.[0]?.message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
      if (!content.trim() && data.choices?.[0]?.finish_reason === "length")
        throw new Error(`${p.name} ran out of tokens before answering. Try a shorter task.`);
      return { content, model: data.model || p.model };
    }
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    let msg = "";
    try { const e = await res.json(); msg = e.error?.message || JSON.stringify(e); } catch { msg = await res.text().catch(() => ""); }
    if (res.status === 401) msg = "Key rejected. " + msg;
    throw new Error(`${p.name} ${res.status}: ${msg}`);
  }
}

/** Pulls the first JSON object out of a reply, tolerating code fences. */
export function parseJSON(text) {
  const t = String(text || "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error("Reply was not JSON");
}

/** Connection tests used by the Settings page. */
export const testCerebras = (cfg) => testDeepSeek({ ...cfg, planner: "cerebras" });

export async function testDeepSeek(cfg) {
  if (cfg.planner !== "cerebras") cfg = { ...cfg, planner: "deepseek" };
  const out = [];
  try {
    const r = await chat(cfg, [{ role: "user", content: 'Reply with this JSON and nothing else: {"ok": true}' }], { maxTokens: 300 });
    const j = parseJSON(r.content);
    out.push({ name: "Chat", ok: j.ok === true, detail: `${r.model} replied ${JSON.stringify(j)}` });
  } catch (e) {
    out.push({ name: "Chat", ok: false, detail: e.message });
    return out;
  }
  if (planner(cfg).vision) {
    try {
      const img = await makeTestImage();
      const r = await chat(cfg, [{
        role: "user",
        content: [
          { type: "text", text: 'What colour is the square in this image? Reply as JSON: {"color": "..."}' },
          { type: "image_url", image_url: { url: img.dataUrl } }
        ]
      }], { maxTokens: 300 });
      const j = parseJSON(r.content);
      out.push({ name: "Vision", ok: /red/i.test(j.color || ""), detail: `Saw ${j.color || "nothing"}` });
    } catch (e) {
      out.push({ name: "Vision", ok: false, detail: e.message });
    }
  }
  return out;
}

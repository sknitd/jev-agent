// Minimal typed client for TypeSafe's System One API (Jev).
// Docs: https://docs.typesafe.ai/api , https://docs.typesafe.ai/images , https://docs.typesafe.ai/primitives/box
import { makeTestImage } from "./image.js";

/** @typedef {string | Record<string, any> | any[]} Content */
/** @typedef {{type:"noul", instructions:Content, criteria?:{true?:Content,false?:Content}}} NoulQuestion */
/** @typedef {{type:"choice", instructions:Content, criteria:Record<string, Content|null>}} ChoiceQuestion */
/** @typedef {{type:"score", instructions:Content, criteria:Content[]}} ScoreQuestion */
/** @typedef {{type:"box", instructions:Content}} BoxQuestion */
/** @typedef {NoulQuestion|ChoiceQuestion|ScoreQuestion|BoxQuestion} Question */

/** @typedef {{type:"noul", noul:number}} NoulAnswer */
/** @typedef {{type:"choice", choice:string, probabilities:Record<string,number>, confidence:number}} ChoiceAnswer */
/** @typedef {{type:"score", score:number, legend:Record<string,string>, probabilities:Record<string,number>, confidence:number}} ScoreAnswer */
/** @typedef {{type:"box", box:{top:number,bottom:number,left:number,right:number}, confidence:number}} BoxAnswer */
/** @typedef {NoulAnswer|ChoiceAnswer|ScoreAnswer|BoxAnswer} Answer */

/** @typedef {{type?:"image", format:"jpg"|"jpeg"|"png", data_base64:string}} ImageAsset */
/**
 * @typedef {Object} SystemOneRequest
 * @property {string} model
 * @property {Content} state
 * @property {Record<string, Question>} questions
 * @property {Record<string, ImageAsset>} [assets]
 */
/** @typedef {{model:string, answers:Record<string, Answer>, usage:{input_tokens:number, output_tokens:number}}} SystemOneResult */

export class TypeSafeError extends Error {
  constructor(status, body) {
    const detail = typeof body === "string" ? body : (body?.detail || body?.error?.message || body?.message || JSON.stringify(body));
    super(`TypeSafe ${status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
    this.status = status;
    this.body = body;
  }
}

// ---- question builders -------------------------------------------------
/** @returns {NoulQuestion} */
export const noul = (instructions, criteria) => ({ type: "noul", instructions, ...(criteria ? { criteria } : {}) });
/** @returns {ChoiceQuestion} */
export const choice = (instructions, criteria) => ({ type: "choice", instructions, criteria });
/** @returns {ScoreQuestion} */
export const score = (instructions, criteria) => ({ type: "score", instructions, criteria });
/** @returns {BoxQuestion} */
export const box = (instructions) => ({ type: "box", instructions });

/** Reference strings are matched as plain text, so use a fresh UUID per image. */
export const newRef = (prefix = "img") => `${prefix}-${crypto.randomUUID()}`;

/** @param {{base64:string, format:string}} img @returns {ImageAsset} */
export const imageAsset = (img) => ({ type: "image", format: img.format, data_base64: img.base64 });

/**
 * Typed accessor: throws if the answer is missing or the wrong type.
 * @template {Answer["type"]} T
 * @param {SystemOneResult} res @param {string} id @param {T} type
 * @returns {Extract<Answer, {type:T}>}
 */
export function answerOf(res, id, type) {
  const a = res.answers?.[id];
  if (!a) throw new Error(`Jev returned no answer for "${id}"`);
  if (a.type !== type) throw new Error(`Jev answer "${id}" is ${a.type}, expected ${type}`);
  return /** @type {any} */ (a);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /v1/systemone. Adds the images header when the request has an image or a Box question.
 * Retries 429 / 529 with exponential backoff, as the docs recommend.
 * @param {{typesafeKey:string, typesafeBase?:string}} cfg
 * @param {SystemOneRequest} req
 * @param {{signal?:AbortSignal, retries?:number}} [opts]
 * @returns {Promise<SystemOneResult>}
 */
export async function systemOne(cfg, req, { signal, retries = 4 } = {}) {
  if (!cfg.typesafeKey) throw new Error("TypeSafe API key is missing. Add it in Settings.");
  const base = (cfg.typesafeBase || "https://api.typesafe.ai").replace(/\/+$/, "");
  const hasAssets = req.assets && Object.keys(req.assets).length > 0;
  const hasBox = Object.values(req.questions).some((q) => q.type === "box");

  const headers = { Authorization: `Bearer ${cfg.typesafeKey}`, "Content-Type": "application/json" };
  if (hasAssets || hasBox) headers["TypeSafe-Danger-Zone-Images"] = "true";

  const body = { model: req.model, state: req.state, questions: req.questions };
  if (hasAssets) body.assets = req.assets;
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/v1/systemone`, { method: "POST", headers, body: payload, signal });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 500 * 2 ** attempt);
      continue;
    }
    let b; try { b = await res.json(); } catch { b = await res.text().catch(() => ""); }
    throw new TypeSafeError(res.status, b);
  }
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** Connection test used by the Settings page: text, image, and (optionally) Box. */
export async function testTypeSafe(cfg) {
  /** @type {{name:string, ok:boolean, detail:string}[]} */
  const out = [];
  try {
    const r = await systemOne(cfg, {
      model: cfg.jevModel,
      state: "Connection test from the Jev Browser Agent extension.",
      questions: { ping: noul("Is this text a connection test?") }
    });
    out.push({ name: "Text", ok: true, detail: `${r.model} answered, yes ${pct(answerOf(r, "ping", "noul").noul)}` });
  } catch (e) {
    out.push({ name: "Text", ok: false, detail: e.message });
    return out;
  }

  const img = await makeTestImage();
  try {
    const ref = newRef("test");
    const r = await systemOne(cfg, {
      model: cfg.jevModel,
      state: { image: ref },
      assets: { [ref]: imageAsset(img) },
      questions: { red: noul("Is there a red square in `image`?") }
    });
    const p = answerOf(r, "red", "noul").noul;
    out.push({ name: "Images", ok: p > 0.5, detail: `Red square seen, yes ${pct(p)}` });
  } catch (e) {
    out.push({ name: "Images", ok: false, detail: e.message });
  }

  if (cfg.useBox) {
    try {
      const ref = newRef("test");
      const r = await systemOne(cfg, {
        model: cfg.boxModel,
        state: { image: ref },
        assets: { [ref]: imageAsset(img) },
        questions: { where: box("the red square in `image`") }
      });
      const a = answerOf(r, "where", "box");
      const b = a.box;
      const cx = (b.left + b.right) / 2, cy = (b.top + b.bottom) / 2;
      const hit = cx > 0.3 && cx < 0.7 && cy > 0.3 && cy < 0.7;
      out.push({
        name: "Box",
        ok: hit,
        detail: `${r.model}: left ${b.left.toFixed(2)}, top ${b.top.toFixed(2)}, right ${b.right.toFixed(2)}, bottom ${b.bottom.toFixed(2)}, confidence ${pct(a.confidence)}`
      });
    } catch (e) {
      out.push({ name: "Box", ok: false, detail: e.message });
    }
  }
  return out;
}

/** @typedef {typeof DEFAULTS} Settings */
export const DEFAULTS = {
  // TypeSafe Jev
  typesafeKey: "",
  typesafeBase: "https://api.typesafe.ai",
  jevModel: "jev-latest",      // Choice / Noul grounding + checks (images work on 1.13+)
  boxModel: "jev-preview",     // Box questions need Jev 1.14 (jev-preview or jev-1.14.0)
  useBox: true,                // fall back to on-screen Box location when Choice is unsure
  // DeepSeek helper (planner)
  deepseekKey: "",
  deepseekBase: "https://api.deepseek.com",
  deepseekModel: "deepseek-flash", // V4.1 Flash. Older alias: deepseek-v4-flash
  deepseekVision: false,       // also send the screenshot to DeepSeek
  // Cerebras (planner alternative, OpenAI-compatible)
  cerebrasKey: "",
  cerebrasBase: "https://api.cerebras.ai/v1",
  cerebrasModel: "qwen-3.8-27b",
  planner: "deepseek",         // which model plans the steps: "deepseek" | "cerebras" (picked in the side panel)
  // Agent behaviour
  maxSteps: 80,                // logins and bookings take 40-70 steps
  choiceThreshold: 0.55,
  boxThreshold: 0.5,
  riskThreshold: 0.6,
  confirmRisky: true,
  setOfMark: true,             // draw element ids on the screenshot Jev sees
  trustedInput: true           // real mouse/keyboard via chrome.debugger; sites ignore scripted clicks
};

/** @returns {Promise<Settings>} */
export async function getSettings() {
  const s = await chrome.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

/** @param {Partial<Settings>} patch */
export async function saveSettings(patch) {
  await chrome.storage.local.set(patch);
}

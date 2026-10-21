import { getSettings } from "./lib/settings.js";
import { systemOne, noul, choice, box, newRef, imageAsset, answerOf } from "./lib/typesafe.js";
import { chat, parseJSON, planner } from "./lib/deepseek.js";
import { prepareScreenshot } from "./lib/image.js";
import { redactGoal, fillSecrets } from "./lib/secrets.js";

// Open the side panel when the toolbar icon is clicked.
const panelOnClick = () => chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
chrome.runtime.onInstalled.addListener(panelOnClick);
chrome.runtime.onStartup.addListener(panelOnClick);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (x) => `${Math.round(x * 100)}%`;
const ACTIONS = new Set(["click", "type", "select", "hover", "scroll", "navigate", "back", "press_key", "wait", "fill", "ask_user", "handoff", "done", "fail"]);
const NEEDS_TARGET = new Set(["click", "type", "select", "hover"]);

// ---- panel connection -----------------------------------------------------
const ports = new Set();
/** @type {{goal:string, tabId:number, controller:AbortController, log:any[], running:boolean} | null} */
let current = null;
const pendingConfirms = new Map();
const pendingAsks = new Map();

function emit(ev) {
  if (current) current.log.push(ev);
  for (const p of ports) { try { p.postMessage(ev); } catch {} }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "panel") return;
  ports.add(port);
  port.postMessage({ type: "replay", running: !!current?.running, events: current?.log || [] });
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener((msg) => {
    if (msg.type === "start") {
      if (current?.running) return port.postMessage({ type: "error", message: "A task is already running. Stop it first." });
      startRun(String(msg.prompt || "").trim(), msg.tabId);
    } else if (msg.type === "stop") {
      current?.controller.abort();
      for (const [, resolve] of pendingConfirms) resolve(false);
      for (const [, resolve] of pendingAsks) resolve(null);
    } else if (msg.type === "confirm") {
      pendingConfirms.get(msg.id)?.(!!msg.approve);
    } else if (msg.type === "answer") {
      pendingAsks.get(msg.id)?.(String(msg.reply ?? ""));
    }
  });
});

async function startRun(rawGoal, tabId) {
  if (!rawGoal) return;
  const { goal, secrets } = redactGoal(rawGoal);
  const controller = new AbortController();
  current = { goal, tabId, controller, log: [], running: true };
  // Keep the service worker awake during long runs.
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  emit({ type: "run-start", goal });
  let end;
  try {
    end = await runAgent(goal, secrets, tabId, controller.signal);
  } catch (e) {
    end = controller.signal.aborted
      ? { status: "stopped", answer: "Stopped." }
      : { status: "error", answer: e.message || String(e) };
  } finally {
    clearInterval(keepAlive);
    await detachAll();
    for (const [, resolve] of pendingConfirms) resolve(false);
    pendingConfirms.clear();
    for (const [, resolve] of pendingAsks) resolve(null);
    pendingAsks.clear();
    current.running = false;
  }
  emit({ type: "run-end", ...end });
}

function checkAbort(signal) {
  if (signal.aborted) throw new DOMException("Stopped", "AbortError");
}

// ---- guards -------------------------------------------------------------------
const CAPTCHA_RE = /captcha|otp\b|one[- ]time password|verification code/i;
// Buttons that actually take money. "Proceed to Pay" is not one: on Paytm/others it only leads to the payment page.
const PAY_BUTTON_RE = /\b(pay\s*(?:&|and)\s*book|pay\s*now|make\s*payment|confirm\s*(?:&|and)\s*pay|pay\s*(?:₹|rs\.?|inr)\s*[\d,])/i;
const PAY_URL_RE = /\/payment\/|bkgPaymentOptions|paymentredirect|razorpay|payu\.in|billdesk|ccavenue|juspay|securepay|securegw|\/theia\/|\/checkout\/pay|:\/\/(payments?|pay|checkout)\.[a-z0-9-]+\.[a-z]/i;
const PAY_METHODS = [/\bupi\b/i, /credit\s*(?:\/\s*debit)?\s*card|debit\s*card/i, /net\s*-?\s*banking/i, /\bwallets?\b/i, /pay\s*later/i, /\bemi\b/i];

/** @returns {string|null} why this looks like a payment page: a gateway URL, or payment methods plus a pay control in view */
function paymentPage(page) {
  if (PAY_URL_RE.test(page.url || "")) return "payment URL";
  const inView = (page.elements || []).filter((e) => !/\[off-screen/.test(e.desc));
  const text = page.text || "";
  const methods = PAY_METHODS.filter((re) => re.test(text)).length;
  const payControl = inView.find((e) => PAY_BUTTON_RE.test(e.desc) || /card number|cvv|upi id|vpa/i.test(e.desc));
  if (methods >= 2 && payControl) return `payment options with ${payControl.desc}`;
  return null;
}

const IRCTC_HOME = "https://www.irctc.co.in/nget/train-search";
const IRCTC_SORRY = /Sorry!+\s*Please Try again|This error has occur+ed for one of the following reasons/i;
const BUSY_TOAST = /busy|try again|unable|cannot|can't|could not|couldn't|failed|failure|error|timed? ?out|not respond|technical|went wrong|please wait/i;

/**
 * IRCTC shows "Server busy" style toasts at the top right. When one appears after a step,
 * dismiss it and run the same step again straight away (up to 8 times).
 */
async function retryOnBusy(tabId, step, redo, signal) {
  for (let i = 1; i <= 8; i++) {
    const toasts = await chrome.tabs.sendMessage(tabId, { cmd: "toasts" }).catch(() => []);
    const busy = (toasts || []).find((t) => BUSY_TOAST.test(t));
    if (!busy) return { retried: i - 1 };
    await chrome.tabs.sendMessage(tabId, { cmd: "dismissToasts" }).catch(() => {});
    emit({ type: "act", step, ok: false, detail: `IRCTC: "${busy.slice(0, 80)}". Retrying the same step (${i}/8)…` });
    checkAbort(signal);
    await redo();
    await settle(tabId, signal);
  }
  return { retried: 8, stillBusy: true };
}

const NOT_BOOKABLE = /NOT AVAILABLE|REGRET|DEPARTED|CHART PREPARED|NOT AVL/i;

/**
 * After a class box was clicked on IRCTC: if it says NOT AVAILABLE / REGRET, fetch the other classes
 * in the same train and ask the user which to take.
 * @returns {Promise<string|null|undefined>} a note for the planner, null if the user stopped, undefined if all is fine
 */
async function irctcNotAvailable(tabId, step, target, brief, signal) {
  const now = await chrome.tabs.sendMessage(tabId, { cmd: "irctcClasses", id: target.id, check: false }).catch(() => null);
  const mine = now?.classes.find((c) => target.label.includes(`(${c.code})`));
  if (!mine || !NOT_BOOKABLE.test(mine.status)) return undefined;

  emit({ type: "act", step, ok: false, detail: `${mine.code} on ${now.train}: ${mine.status}. Checking the other classes…` });
  const all = await chrome.tabs.sendMessage(tabId, { cmd: "irctcClasses", id: target.id, check: true }).catch(() => now);
  checkAbort(signal);
  const others = (all?.classes || []).filter((c) => c.code !== mine.code);
  const bookable = others.filter((c) => c.status && !NOT_BOOKABLE.test(c.status) && !/no answer/.test(c.status));
  const list = others.map((c) => `${c.code}: ${c.status || "unknown"}`).join("; ");
  const question = bookable.length
    ? `${mine.code} is ${mine.status} on ${now.train}. Other classes: ${list}. Type the class to book instead (e.g. ${bookable[0].code}) and press Continue, or press Stop task.`
    : `${mine.code} is ${mine.status} on ${now.train}, and no other class on this train is bookable (${list || "none found"}). Type another train number or class to try, or press Stop task.`;
  const reply = await askUser({ step, question });
  if (reply == null) return null;
  const want = (reply.match(/\b(SL|3A|2A|1A|3E|CC|EC|2S)\b/i) || [])[1]?.toUpperCase();
  if (!reply.trim() || /^(no|stop|cancel)\b/i.test(reply.trim())) return null;
  if (want && brief?.irctc) brief.irctc.class = want;
  return want
    ? `The user chose class ${want} instead of ${mine.code} on ${now.train}. Click the ${want} class box in that train's card (it must show an AVAILABLE/WL status for the date), click the date cell if one appears, then Book Now. Book ${want} for everything that follows.`
    : `The user replied "${reply}" to: ${question} Follow that.`;
}

/** @returns {string|null} why this click is something the goal never asked for */
function unaskedExtra(label, goal) {
  const l = label.toLowerCase(), g = goal.toLowerCase();
  if (/gst number|gstin|company name|registration no/.test(l) && !/\bgst/.test(g)) return "the goal says nothing about GST; never tick or untick the GST option";
  if (/lock now|lock this price|lock price/.test(l) && !/\block/.test(g)) return "LOCK NOW is a paid price lock, not part of booking";
  const noAddons = /no[\s-]*add[\s-]*ons?|without add[\s-]*ons?|no extras/.test(g);
  const declining = /don.?t want|\bno,? i |without|skip|not interested|no thanks/.test(l);
  if (noAddons && !declining && (/yes,? secure my trip|price drop protection|zero cancellation|free cancellation|flexifly|travel insurance|trip secure|\badd\b"?$/.test(l) || /^(button|clickable box) "add"/.test(l)))
    return "the goal says no add-ons";
  return null;
}

/** What a flight booking will need that the request didn't give. */
function travellerGaps(brief) {
  if (!brief?.flight || !Array.isArray(brief.travellers)) return [];
  const out = [];
  for (const t of brief.travellers) {
    const who = `${t.first || "traveller"} ${t.last || ""}`.trim();
    const need = [];
    if (!t.last) need.push("last name");
    if (!/^[mf]/i.test(t.gender || "")) need.push("gender");
    if (!/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/.test(t.dob || "")) need.push("date of birth");
    if (need.length) out.push(`${need.join(", ")} for ${who}`);
  }
  return out;
}

/** Spreads the user's answer ("Priya Sharma f 05/03/1995; ...") over the travellers, in order. */
function applyTravellerReply(brief, reply) {
  const parts = String(reply || "").split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
  const dates = String(reply).match(/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/g) || [];
  brief.travellers.forEach((t, i) => {
    const seg = parts.length === brief.travellers.length ? parts[i] : (parts.find((p) => t.first && p.toLowerCase().includes(t.first.toLowerCase())) || "");
    const d = seg.match(/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/)?.[0] || (parts.length <= 1 ? dates[i] : null);
    if (d && !/\d/.test(t.dob || "")) t.dob = d;
    const g = seg.match(/\b(male|female|m|f)\b/i)?.[1] || (parts.length <= 1 && brief.travellers.length === 1 ? String(reply).match(/\b(male|female|m|f)\b/i)?.[1] : null);
    if (g && !/^[mf]/i.test(t.gender || "")) t.gender = g[0].toLowerCase();
    if (!t.last && t.first && seg) {
      const words = seg.replace(/\d[\d\/.\-]*/g, "").split(/[\s,]+/).filter((w) => w && !/^(m|f|male|female|mr|ms|mrs)$/i.test(w));
      const i0 = words.findIndex((w) => w.toLowerCase() === t.first.toLowerCase());
      if (i0 >= 0 && words[i0 + 1]) t.last = words[i0 + 1];
    }
  });
}

/** MakeMyTrip traveller form: rows, names (real typing), gender, DOB, country code, insurance, billing, CONTINUE. */
async function mmtReview(tabId, brief, cfg, signal) {
  const page = (msg) => chrome.tabs.sendMessage(tabId, msg).catch((e) => ({ ok: false, detail: e.message }));
  const params = {
    travellers: brief.travellers.map((t) => ({ first: t.first, last: t.last, gender: t.gender, dob: t.dob })),
    mobile: brief.contact?.mobile, email: brief.contact?.email, countryCode: brief.contact?.country_code || "91",
    insurance: !!brief.wants?.insurance, wheelchair: !!brief.wants?.wheelchair
  };
  let prep;
  for (let i = 0; i < 3; i++) {
    prep = await page({ cmd: "mmtPrepare", params });
    if (!prep?.retry) break;
    await settle(tabId, signal);
    await sleep(1500);
  }
  if (!prep?.ok) return { ok: false, detail: prep?.detail || "the traveller script couldn't run" };
  const parts = [...(prep.done || [])];
  if (prep.text.length) {
    const r = (cfg.trustedInput ? await fillReal(tabId, prep.text).catch(() => null) : null) || await page({ cmd: "fill", fields: prep.text });
    parts.push(r.detail);
  }
  if (prep.other.length) parts.push((await page({ cmd: "fill", fields: prep.other })).detail);
  await settle(tabId, signal);
  if (prep.missing?.length) return { ok: false, detail: parts.join(". "), missing: prep.missing };
  if (prep.continueId) {
    await execute(tabId, { action: "click" }, { id: prep.continueId, label: 'button "CONTINUE"' }, cfg);
    await settle(tabId, signal);
    await sleep(1200);
    const after = await page({ cmd: "snapshot" });
    if (after?.errors?.length) return { ok: false, detail: `${parts.join(". ")}. CONTINUE showed errors`, errors: after.errors.map((e) => e.text) };
    parts.push("pressed CONTINUE");
  }
  return { ok: true, detail: parts.join(". ") };
}

/** Clicks through Seats / Meals / Cabs / Add-ons without adding anything, until the payment page. */
async function mmtAddons(tabId, cfg, signal) {
  const clicked = [];
  let last = "", same = 0;
  for (let i = 0; i < 14; i++) {
    checkAbort(signal);
    const snap = await chrome.tabs.sendMessage(tabId, { cmd: "snapshot" }).catch(() => null);
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab && PAY_URL_RE.test(tab.url || "")) return { payment: true, clicked };
    if (snap && paymentPage({ ...snap, url: tab?.url || snap.url })) return { payment: true, clicked };
    const next = await chrome.tabs.sendMessage(tabId, { cmd: "mmtNextAddon" }).catch(() => null);
    if (!next || PAY_BUTTON_RE.test(next.label)) break;
    same = next.label === last ? same + 1 : 0;
    if (same >= 3) break;
    last = next.label;
    await execute(tabId, { action: "click" }, { id: next.id, label: `button "${next.label}"` }, cfg);
    clicked.push(next.label);
    await settle(tabId, signal);
    await sleep(700);
  }
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return { payment: !!tab && PAY_URL_RE.test(tab.url || ""), clicked };
}

/** MakeMyTrip's results page has a stable URL, so the whole search form can be skipped. */
function mmtSearchUrl(f) {
  if (!f || !/^[A-Z]{3}$/i.test(f.from || "") || !/^[A-Z]{3}$/i.test(f.to || "") || !/^\d{2}\/\d{2}\/\d{4}$/.test(f.date || "")) return null;
  const n = (x, d = 0) => Math.max(0, Math.min(9, parseInt(x, 10) || d));
  const cabin = { economy: "E", premium: "PE", business: "B", first: "F" }[String(f.cabin || "economy").toLowerCase().split(/\s/)[0]] || "E";
  return `https://www.makemytrip.com/flight/search?itinerary=${f.from.toUpperCase()}-${f.to.toUpperCase()}-${f.date}&tripType=O&paxType=A-${n(f.adults, 1) || 1}_C-${n(f.children)}_I-${n(f.infants)}&intl=false&cabinClass=${cabin}&lang=eng`;
}

/** Spots the agent going round in circles (scroll up, scroll down, ...) and says so. */
function loopNote(history) {
  const recent = history.slice(-6).filter((h) => h.action !== "note");
  if (recent.length < 4) return null;
  const last4 = recent.slice(-4);
  const scrolls = last4.filter((h) => h.action === "scroll").length;
  const sig = (h) => `${h.action}|${h.target}|${h.text || ""}`;
  const repeats = new Set(last4.map(sig)).size <= 2 && last4.length === 4;
  if (scrolls >= 3 || repeats) {
    return "LOOP: your last actions keep repeating without progress. Scrolling won't show anything new: every form field on the page is already in the element list (some marked off-screen). " +
      "If something you're looking for isn't in the list, it doesn't exist on this page; skip it. Take the next real step now (fill what's missing, or click Continue / the next button).";
  }
  return null;
}

function redact(text, secrets) {
  let out = String(text ?? "");
  for (const [k, v] of Object.entries(secrets)) if (v) out = out.split(v).join(`{{${k}}}`);
  return out;
}

function today() {
  const d = new Date();
  return `${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })} (DD/MM/YYYY ${d.toLocaleDateString("en-GB")})`;
}

// ---- brief (DeepSeek) ---------------------------------------------------------
const DOMAIN_NOTES = `Indian Railways / IRCTC shorthand:
- Stations by code: LTT = Lokmanya Tilak Terminus (Mumbai), SC = Secunderabad Jn, CSMT = Mumbai CSMT, NDLS = New Delhi, HYB = Hyderabad Decan, MAS = MGR Chennai Central, SBC = KSR Bengaluru, HWH = Howrah, PUNE = Pune Jn, BCT = Mumbai Central. On IRCTC type the code and pick the suggestion that shows the code, e.g. "LOKMANYATILAK T - LTT".
- Classes: 1A First AC, 2A AC 2 Tier, 3A AC 3 Tier ("3ac"), 3E AC 3 Economy, SL Sleeper, CC AC Chair Car, EC Exec Chair Car, 2S Second Sitting.
- Quota: GN General (default), TQ Tatkal, LD Ladies, SS Senior/lower berth.
- Passenger shorthand "name/age/gender/berth/food": gender m = Male, f = Female, t = Transgender. Berth lb = Lower, mb = Middle, ub = Upper, sl = Side Lower, su = Side Upper, nb/np = No Preference. Food veg = Veg, nonveg/nv = Non Veg, none/nf = No Food.
- A 5-digit number is a train number (e.g. 12219).
- A date without a year means the next such date from today.
Traveller shorthand (flights, buses): "ms Priya Sharma, f, 05.03.1995" = title Ms, name Priya Sharma, female, date of birth 5 March 1995. A date written next to a traveller's name is that traveller's date of birth (DD.MM.YYYY, DD/MM/YYYY or DD-MM-YYYY, day first); the journey date is the one after "to"/"on" or with a month name like 24nov.
Flights: IXR Ranchi, BLR Bengaluru, DEL Delhi, BOM Mumbai, MAA Chennai, CCU Kolkata, HYD Hyderabad, PNQ Pune, GOI/GOX Goa, AMD Ahmedabad, PAT Patna, JAI Jaipur, LKO Lucknow, COK Kochi. "fli8"/"flt" = flight, "mmt" = MakeMyTrip (https://www.makemytrip.com/flights/).
Paytm flights ("paytm fli8"): https://tickets.paytm.com/flights. On the review page pick "I don't want Free Cancellation" when there are no add-ons, add the traveller with "+ Add New Traveller", fill the form, then "Proceed To Pay" leads to the payment page (that is where to stop).
MakeMyTrip:
- Close the login popup (its close X, or Escape). Keep One Way selected.
- From/To boxes are read-only: click the From box, then type the city into the input that appears (placeholder "From"), then click the suggestion option with the airport code. Same for To.
- Date: click the departure date box, use the next-month arrow until the month shows, then click the day cell (its label reads like "Tue Nov 24 2026").
- Travellers: set the adult count to the number of people (data-cy adults-2 etc.), then Apply. The agent may open the results page directly instead.
- Results are listed cheapest first. Click the small "VIEW PRICES" button inside the first flight's card (not the card itself), then "BOOK NOW" on the cheapest fare (usually SAVER). Booking opens in a new tab; the agent follows it.
- A login popup can appear anywhere: close it with its X / close button. Never click CONTINUE inside the login popup and never log in.
- Review page (no login needed): click "+ ADD NEW ADULT" once per traveller, then fill each ADULT block: First & Middle Name, Last Name, gender (the MALE / FEMALE radio), and Date of birth if shown (Date / Month / Year are searchable dropdowns: type e.g. "15", "Mar", "1995"). Fill the booking contact Mobile No and Email. Trip insurance: pick "No, I will book without trip secure" unless the goal wants it. Then CONTINUE. If a date of birth or other required detail isn't in the goal, ask_user for it.
- Each ADULT block has its own Country Code (fill "91"), Mobile No and Email; fill them with the goal's mobile/email too, and the booking contact Country Code with "91".
- Never touch "I have a GST number" or LOCK NOW. If "Confirm and save billing details to your profile" shows as an error or "unchecked", click it once; if it says "checked", leave it. Don't touch the State field.
- If CONTINUE does nothing, read the FORM ERRORS and fix those; don't click other buttons hoping one works.
- Seats & Meals page: don't pick seats or meals; click CONTINUE, and if a popup asks about skipping seats, choose the skip / continue-without option.
- After CONTINUE there may be a review popup (CONFIRM) and a seats/meals page: skip seats and meals (Skip / Continue / "Skip to payment"); no add-ons unless asked. The payment page is handoff.
IRCTC site (https://www.irctc.co.in/nget/train-search):
- Never use back, navigate/reload, or new tabs once on IRCTC: it kills the session ("Sorry!!! Please Try again!!"). The agent restarts automatically if that page appears, and retries a step itself when a "server busy" popup shows.
- Close any alert/popup with its OK or close button first.
- Log in from the LOGIN button at the top. If the goal gives a username and password, type them. If it doesn't, type neither: the browser fills the user's saved login. Then ask_user for the captcha; when the run continues the captcha is filled, so click SIGN IN.
- From and To are autocomplete boxes: type the station code, then click the matching suggestion in the list that appears.
- Journey date is a text field: type the date as DD/MM/YYYY (it replaces the old value), then press Escape to close the calendar.
- Class and Quota are custom dropdowns: click the dropdown, then click the option.
- Click Search. In the results find the card for the train number. Its "Book Now" stays disabled (faded) until you:
  1. click the class box inside THAT train's card, e.g. clickable box "AC 3 Tier (3A) Refresh" (in: "SC DURONTO EXP (12219) ..."); clicking Refresh is fine too;
  2. then click the availability cell for the journey date that appears in the same card, e.g. "Wed, 21 Oct AVAILABLE-0012" or "RLWL"/"WL" (any status is fine unless the goal says otherwise);
  3. only then click "Book Now" in that same card.
  Never click a disabled Book Now; do steps 1-2 first.
- Passenger page: fill each passenger's Name, Age, Gender, Berth Preference and Food Choice (native dropdowns: use select). Use "+ Add Passenger" for each extra passenger. Fill the mobile number only if empty. Pick a payment mode option if asked (e.g. "Pay through BHIM/UPI" or the first option), then click Continue.
- Review page: if there is a captcha, ask_user, then click Continue.
- The payment page (Pay & Book, payment methods) is where the agent stops: use handoff.`;

const BRIEF_SYSTEM = `You turn a short browser-task request into a clear plan for a browser agent.
${DOMAIN_NOTES}

Reply with one JSON object: {"task": "the request restated in full words, with every value spelled out", "site": "start URL", "values": {"field": "value"}, "steps": ["short step", ...], "stop_at": "when the agent must stop and hand over", "irctc": {"from": "LTT", "to": "SC", "date": "DD/MM/YYYY", "class": "3A", "quota": "GN", "train": "12219"}}.
For any booking also include "travellers": [{"title": "Ms", "first": "Priya", "last": "Sharma", "gender": "f", "dob": "DD/MM/YYYY", "age": 30}] (one per person, in order; empty string for anything not given) and "contact": {"mobile": "", "email": "", "country_code": "91"}, plus "wants": {"insurance": false, "wheelchair": false, "addons": false} (true only if the request asks for it).
Include "irctc" only for an IRCTC train booking or search; use station codes and class codes, and leave out what the request doesn't say.
For a one-way flight search also include "flight": {"from": "IXR", "to": "BLR", "date": "DD/MM/YYYY", "adults": 2, "children": 0, "infants": 0, "cabin": "economy"}, counting travellers from the names given (each named person is an adult unless an age says otherwise).
Keep {{PLACEHOLDERS}} exactly as written; they stand for secrets the agent fills in later. Never invent values the request doesn't give.`;

async function makeBrief(cfg, goal, signal) {
  const r = await chat(cfg, [
    { role: "system", content: BRIEF_SYSTEM },
    { role: "user", content: `Today is ${today()}.\nRequest: ${goal}` }
  ], { signal });
  const b = parseJSON(r.content);
  if (!b || typeof b !== "object" || !b.task) throw new Error("no brief");
  return b;
}

function briefText(brief) {
  if (!brief) return "";
  const vals = brief.values && typeof brief.values === "object"
    ? Object.entries(brief.values).map(([k, v]) => `- ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n") : "";
  const steps = Array.isArray(brief.steps) ? brief.steps.map((x, i) => `${i + 1}. ${x}`).join("\n") : "";
  return `Task in full: ${brief.task}
${brief.site ? `Start at: ${brief.site}\n` : ""}${vals ? `Values:\n${vals}\n` : ""}${steps ? `Plan:\n${steps}\n` : ""}${brief.stop_at ? `Stop when: ${brief.stop_at}\n` : ""}`;
}

// ---- main loop --------------------------------------------------------------
async function runAgent(goal, secrets, tabId, signal) {
  // Sites like MakeMyTrip open the booking in a new tab: follow it.
  const tabs = { id: tabId, opened: null };
  const onCreated = (t) => { if (t.openerTabId === tabs.id) tabs.opened = t.id; };
  chrome.tabs.onCreated.addListener(onCreated);
  try {
    return await agentLoop(goal, secrets, tabs, signal);
  } finally {
    chrome.tabs.onCreated.removeListener(onCreated);
  }
}

async function agentLoop(goal, secrets, tabs, signal) {
  let tabId = tabs.id;
  const banned = new Map(); // element id -> step it was banned at
  const cfg = await getSettings();
  if (!cfg.typesafeKey) throw new Error("Add your TypeSafe API key in Settings.");
  if (!planner(cfg).key) throw new Error(`Add your ${planner(cfg).name} API key in Settings.`);

  const brief = await makeBrief(cfg, goal, signal).catch((e) => {
    if (signal.aborted) throw e;
    return null;
  });
  if (brief) emit({ type: "brief", brief });

  // Flights need each traveller's gender and date of birth; ask for whatever is missing now, not halfway through.
  const gaps = travellerGaps(brief);
  if (gaps.length) {
    const reply = await askUser({ step: 0, question: `Before I start: ${gaps.join("; ")}. Type them below, e.g. "Priya Sharma f 05/03/1995" (one traveller per line or separated by ;), or press Continue to skip.` });
    if (reply == null) return { status: "stopped", answer: "Stopped before starting." };
    applyTravellerReply(brief, reply);
  }

  const history = [];
  let doneChallenged = false;
  let fastPathTried = false;
  let emptyPages = 0;
  let irctcRestarts = 0;
  let queue = [], lastObs = null;    // actions the planner sent together, and the page they were planned on
  let mmtReviewTries = 0, mmtAddonTries = 0;
  let scrollBlockedUntil = 0;
  let mmtTried = false;

  for (let step = 1; step <= cfg.maxSteps; step++) {
    checkAbort(signal);
    emit({ type: "step", step });

    if (tabs.opened) {
      tabId = tabs.id = tabs.opened;
      tabs.opened = null;
      if (current) current.tabId = tabId;
      history.push({ step, action: "note", result: "The last click opened a new tab; the agent switched to it and continues there." });
      await settle(tabId, signal);
    }

    // Queued actions run straight away while the page is still the one they were planned on.
    let queued = null;
    if (queue.length && lastObs) {
      const now = await chrome.tabs.get(tabId).catch(() => null);
      if (now?.url === lastObs.page.url) queued = queue.shift();
      else queue = [];
    }
    const obs = queued ? lastObs : await observe(tabId, cfg, { shot: planner(cfg).vision });
    if (!queued) emit({
      type: "observe", step, url: obs.page.url, title: obs.page.title,
      elements: obs.page.elements.length, restricted: !!obs.page.restricted, thumb: obs.shot?.dataUrl || null
    });
    checkAbort(signal);
    let plan = queued;
    if (!queued) {

    // IRCTC's "Sorry!!! Please Try again!!" page means the session is dead: start over from the search page.
    if (/irctc\.co\.in/i.test(obs.page.url || "") && IRCTC_SORRY.test(obs.page.text || "")) {
      if (++irctcRestarts > 5) return { status: "failed", answer: "IRCTC kept showing \"Sorry!!! Please Try again!!\" after 5 restarts. Try again in a few minutes." };
      emit({ type: "act", step, ok: false, detail: `IRCTC session error page. Restarting from the search page (${irctcRestarts}/5)…` });
      await chrome.tabs.update(tabId, { url: IRCTC_HOME });
      await settle(tabId, signal);
      fastPathTried = false; // fill the search form again
      history.push({ step, action: "note", result: "IRCTC showed its session-error page, so the agent restarted from the train search page. Redo the booking from the start (search, class, Book Now, login if asked). Never use Back, Refresh or new tabs on IRCTC." });
      continue;
    }

    // A site that keeps serving an empty page (bot protection, outage): stop instead of reloading forever.
    const empty = !obs.page.restricted && obs.page.elements.length === 0 && (obs.page.text || "").trim().length < 60;
    emptyPages = empty ? emptyPages + 1 : 0;
    if (emptyPages >= 4) {
      let host = ""; try { host = new URL(obs.page.url).host; } catch {}
      return { status: "failed", answer: `${host || "The site"} keeps serving an empty page ("${(obs.page.text || "").trim().slice(0, 40)}"). It may be blocking automated browsing or be down. Open it yourself in this tab and run the task again from there.` };
    }
    if (emptyPages === 2) history.push({ step, action: "note", result: "The page is still empty. Wait once more; don't keep reloading the same URL." });

    // Payment is always the user's job: stop here and leave the page open.
    const pay = paymentPage(obs.page);
    if (pay) return { status: "handoff", answer: `Reached the payment page (${pay}). Everything before payment is filled in; complete the payment yourself in this tab.` };

    const mmtUrl = mmtSearchUrl(brief?.flight);
    if (mmtUrl && !mmtTried && /makemytrip\.com/i.test(brief?.site || goal) ) {
      mmtTried = true;
      emit({ type: "plan", step, plan: { action: "navigate", url: mmtUrl, thought: "Opening the MakeMyTrip results directly (skips the search form)." } });
      // MakeMyTrip serves a blank "200-OK" stub when the results URL is opened cold; going there from its own page works.
      if (!/makemytrip\.com/i.test(obs.page.url || "")) {
        await chrome.tabs.update(tabId, { url: "https://www.makemytrip.com/flights/" });
        await settle(tabId, signal);
        await sleep(1500);
      }
      await settle(tabId, signal); // don't race a page that is still loading
      await chrome.scripting.executeScript({ target: { tabId }, func: (u) => location.assign(u), args: [mmtUrl] }).catch(() => chrome.tabs.update(tabId, { url: mmtUrl }));
      await settle(tabId, signal);
      await sleep(2500); // results stream in
      const check = await chrome.tabs.sendMessage(tabId, { cmd: "snapshot" }).catch(() => null);
      const ok = (check?.elements?.length || 0) > 5;
      emit({ type: "act", step, ok, detail: ok ? `opened ${mmtUrl}` : "the direct results link came back empty; use the search form instead" });
      history.push({ step, action: "navigate", target: "MakeMyTrip search results", result: ok
        ? `ok: opened the results for ${brief.flight.from} → ${brief.flight.to} on ${brief.flight.date}, ${brief.flight.adults || 1} adult(s)`
        : "the direct results link didn't load. Go to https://www.makemytrip.com/flights/ and use the search form (From, To, date, travellers, SEARCH)." });
      continue;
    }

    if (brief?.irctc && !fastPathTried && /irctc\.co\.in\/nget\/train-search/i.test(obs.page.url || "")) {
      fastPathTried = true;
      const ir = brief.irctc;
      const plan = { action: "irctc_search", thought: "Filling the IRCTC search form directly.", target: [ir.from && ir.to ? `${ir.from} → ${ir.to}` : "", ir.date, ir.class, ir.quota].filter(Boolean).join(", ") };
      emit({ type: "plan", step, plan });
      const search = () => chrome.tabs.sendMessage(tabId, { cmd: "irctcSearch", params: ir }).catch((e) => ({ ok: false, detail: e.message }));
      let result = await search();
      await settle(tabId, signal);
      const r = await retryOnBusy(tabId, step, async () => { result = await search(); }, signal);
      if (r.retried) result.detail += ` (retried ${r.retried}x after IRCTC busy errors)`;
      emit({ type: "act", step, ok: result.ok, detail: result.detail });
      history.push({ step, action: "fill search form", result: result.ok ? `ok: ${result.detail}` : `partly: ${result.detail}` });
      await settle(tabId, signal);
      continue;
    }

    const loop = loopNote(history);
    if (loop && history.slice(-4).filter((h) => h.action === "scroll").length >= 3) scrollBlockedUntil = step + 5;
    if (loop) {
      // Ban the element the loop keeps hitting, so the planner has to try something else.
      const counts = new Map();
      for (const h of history.slice(-6)) if (h.id) counts.set(h.id, (counts.get(h.id) || 0) + 1);
      const [worst, n] = [...counts].sort((a, b) => b[1] - a[1])[0] || [];
      if (worst && n >= 3) {
        banned.set(worst, step);
        const lbl = history.slice(-6).find((h) => h.id === worst)?.target?.match(/"([^"]+)"/)?.[1];
        if (lbl) banned.set(`label:${lbl}`, step); // its label/wrapper is the same control
      }
      history.push({ step, action: "note", result: loop + (worst && n >= 3 ? ` Element ${worst} is now off-limits for a while; it isn't working.` : "") });
    }
    for (const [id, at] of banned) if (step - at > 8) banned.delete(id);

    // MakeMyTrip: traveller form and the Seats/Meals/Cabs/Add-ons steps are done by fixed scripts.
    if (/makemytrip\.com\/flight\/reviewDetails/i.test(obs.page.url || "")) {
      const descs = obs.page.elements.map((e) => e.desc).join("\n");
      const onForm = /ADD NEW ADULT|First & Middle Name|NETWORK PROBLEM/i.test(descs + (obs.page.text || ""));
      const onAddons = /Skip to (seats|meals|cabs|add-?ons|payment)|No,? Let Me Choose|PROCEED TO PAY/i.test(descs);
      if (brief?.travellers?.length && onForm && !onAddons && mmtReviewTries < 2) {
        mmtReviewTries++;
        emit({ type: "plan", step, plan: { action: "mmt_travellers", thought: "Filling the MakeMyTrip traveller form directly.", target: brief.travellers.map((t) => `${t.first} ${t.last || ""}`.trim()).join(", ") } });
        const r = await mmtReview(tabId, brief, cfg, signal);
        emit({ type: "act", step, ok: r.ok, detail: r.detail });
        history.push({ step, action: "fill traveller form", result: r.ok ? `ok: ${r.detail}` : `partly: ${r.detail}${r.errors?.length ? `. Form errors: ${r.errors.join("; ")}` : ""}${r.missing?.length ? `. Missing from the goal: ${r.missing.join(", ")}; ask_user for them` : ""}` });
        if (!r.ok) continue;
      }
      if ((onAddons || mmtReviewTries) && mmtAddonTries < 2) {
        mmtAddonTries++;
        emit({ type: "plan", step, plan: { action: "mmt_skip_addons", thought: "Skipping seats, meals, cabs and add-ons.", target: "to the payment page" } });
        const a = await mmtAddons(tabId, cfg, signal);
        emit({ type: "act", step, ok: a.payment, detail: a.clicked.length ? `clicked ${a.clicked.join(" → ")}` : "nothing to skip" });
        history.push({ step, action: "skip add-ons", result: a.payment ? "reached the payment page" : `clicked ${a.clicked.join(" → ") || "nothing"}; not at payment yet` });
        if (a.payment) return { status: "handoff", answer: "Reached the MakeMyTrip payment page with the travellers filled in and no add-ons. Complete the payment yourself in this tab." };
        continue;
      }
    }

    plan = await planNext(cfg, goal, brief, obs, history, signal);
    if (plan.queue?.length) { queue = plan.queue; lastObs = obs; }
    } // end of the not-queued branch

    // Captchas and OTPs are for the person, never the agent.
    if (plan.action === "type" && CAPTCHA_RE.test(plan.target || "")) {
      plan = { action: "ask_user", thought: plan.thought, question: "Please type the captcha on the page." };
    }
    emit({ type: "plan", step, plan });

    if (plan.action === "click" && /sign ?in|log ?in|login/i.test(plan.target || "")
        && await chrome.tabs.sendMessage(tabId, { cmd: "loginInfo" }).catch(() => null)) {
      const reply = await loginFlow(tabId, step, signal);
      if (reply == null) return { status: "stopped", answer: "Stopped while signing in." };
      history.push({ step, action: "sign in", result: reply === LOGGED_IN ? "pressed SIGN IN with the filled login. Check the page for an error or the logged-in state." : "the login box closed: signed in." });
      await settle(tabId, signal);
      continue;
    }

    if (plan.action === "ask_user") {
      const reply = await waitForHuman(tabId, step, plan.question || plan.answer || plan.thought || "The agent needs you to do something on the page.", signal);
      if (reply == null) return { status: "stopped", answer: "Stopped while waiting for you." };
      history.push({ step, action: "ask_user", target: plan.question, result: reply === LOGGED_IN ? "the agent pressed SIGN IN with the filled login and captcha. Check the page: if the login box is gone you're signed in; if it shows an error, read it." : reply === AUTO ? "the user typed the captcha; it is filled in now, don't touch it. Continue (e.g. click SIGN IN / Continue)." : `the user finished${reply ? ` and said: ${reply}` : ""}` });
      await settle(tabId, signal);
      continue;
    }
    if (plan.action === "handoff") {
      return { status: "handoff", answer: plan.answer || plan.thought || "Handed over to you." };
    }

    if (plan.action === "done") {
      const v = await verifyDone(cfg, goal, plan, obs, signal).catch(() => null);
      emit({ type: "verify", step, probability: v });
      if (v != null && v < 0.3 && !doneChallenged) {
        doneChallenged = true;
        history.push({ step, action: "done", result: `rejected: Jev rated the goal complete at only ${pct(v)}. Look at the page again and keep going.` });
        continue;
      }
      return { status: "done", answer: plan.answer || plan.thought || "Done.", verified: v };
    }
    if (plan.action === "scroll" && step <= scrollBlockedUntil) {
      history.push({ step, action: "scroll", target: plan.direction, result: "refused: scrolling is paused because it went back and forth without progress. Every form field and button is already in the element list (some marked off-screen); act on them by id, e.g. fill the Date/Month/Year dropdowns directly." });
      continue;
    }
    if (plan.action === "fail") return { status: "failed", answer: plan.answer || plan.thought || "Could not complete the task." };

    if (plan.action === "fill") {
      const byId = new Map(obs.page.elements.map((e) => [e.id, e]));
      const skipped = [];
      const fields = plan.fields.filter((f) => {
        const desc = byId.get(f.element_hint)?.desc || "";
        if (CAPTCHA_RE.test(desc)) { skipped.push(`${f.element_hint} (captcha)`); return false; }
        if (!secrets.PASSWORD && /^password field/i.test(desc)) { skipped.push(`${f.element_hint} (saved login)`); return false; }
        return true;
      }).map((f) => ({ id: f.element_hint, value: fillSecrets(f.value, secrets) }));
      let result = !fields.length ? { ok: false, detail: "nothing to fill" }
        : cfg.trustedInput ? await fillReal(tabId, fields).catch((e) => ({ ok: false, detail: e.message })) : null;
      if (!result) result = await chrome.tabs.sendMessage(tabId, { cmd: "fill", fields }).catch((e) => ({ ok: false, detail: e.message }));
      if (skipped.length) result.detail += `. Skipped ${skipped.join(", ")}`;
      emit({ type: "act", step, ok: result.ok, detail: redact(result.detail, secrets) });
      history.push({ step, action: "fill", target: `${fields.length} fields`, result: redact(result.ok ? `ok: ${result.detail}` : `error: ${result.detail}`, secrets) });
      await settle(tabId, signal);
      continue;
    }

    let target = null, risky = null;
    const hinted = trustedHint(plan, obs);
    if (hinted && !cfg.confirmRisky) {
      // The planner named an element that matches its description: act now, skip Jev.
      target = hinted;
      emit({ type: "ground", step, method: "planner", target: { id: hinted.id, label: hinted.label }, top: [], note: "Planner's pick, Jev skipped for speed." });
    } else if (NEEDS_TARGET.has(plan.action)) {
      const g = await ground(cfg, goal, plan, obs, tabId, signal);
      emit({ type: "ground", step, ...g.report });
      target = g.target;
      risky = g.risky;
      if (!target) {
        history.push({ step, action: plan.action, target: plan.target, result: "error: could not find that element in view. Scroll, or describe it differently." });
        continue;
      }
    }

    // Pressing Continue again while the same form errors are showing just wastes a step.
    const prev = history.filter((h) => h.action !== "note").slice(-1)[0];
    if (plan.action === "click" && obs.page.errors?.length && target?.id && prev?.id === target.id) {
      history.push({ step, action: "click", target: target.label, id: target.id, result: `refused: the form still shows errors (${obs.page.errors.map((e) => e.text).join("; ")}). Fix them first, or ask_user once for missing data.` });
      continue;
    }

    const tLabel = target?.label?.match(/"([^"]+)"/)?.[1];
    if (target?.id && (banned.has(target.id) || (tLabel && banned.has(`label:${tLabel}`)))) {
      history.push({ step, action: plan.action, target: target.label, id: target.id, result: `refused: ${target.id} has been tried repeatedly with no effect. Use a different element (e.g. the input or option that appeared after clicking) or another route.` });
      continue;
    }

    // Things the user didn't ask for: GST details, MakeMyTrip's paid price lock, and paid add-ons when "no addon".
    const unasked = plan.action === "click" && unaskedExtra(target?.label || "", goal);
    if (unasked) {
      history.push({ step, action: "click", target: target.label, id: target.id, result: `refused: ${unasked}. Leave it as it is and continue with the next real step (usually CONTINUE).` });
      continue;
    }

    if (plan.action === "click" && /\bdisabled\b/.test(target?.label || "")) {
      history.push({ step, action: "click", target: target.label, result: "error: that element is disabled. Do the step that enables it first (e.g. select the class box and then the date availability cell in the same card)." });
      continue;
    }

    if (plan.action === "type" && CAPTCHA_RE.test(target?.label || "")) {
      const reply = await waitForHuman(tabId, step, "Please type the captcha on the page.", signal);
      if (reply == null) return { status: "stopped", answer: "Stopped while waiting for you." };
      history.push({ step, action: "ask_user", target: "captcha", result: "the user filled in the captcha; do not type into it. Continue (e.g. click SIGN IN / Continue)." });
      continue;
    }

    // No login in the prompt: leave the browser's saved login alone.
    if (plan.action === "type" && !secrets.PASSWORD && /^(password field|email field)|^text field.*\b(user ?name|user ?id|login id|e-?mail)\b/i.test(target?.label || "")) {
      history.push({ step, action: "type", target: target.label, result: "skipped: the goal has no login details, so the browser's saved login fills these fields. Don't type them; ask_user for the captcha next." });
      continue;
    }

    if (plan.action === "click" && PAY_BUTTON_RE.test(target?.label || plan.target || "")) {
      return { status: "handoff", answer: `Stopped before "${target?.label || plan.target}". The booking is ready for payment; complete it yourself in this tab.` };
    }

    if (cfg.confirmRisky && risky != null && risky >= cfg.riskThreshold) {
      const ok = await askConfirm({ step, probability: risky, summary: summarize(plan, target) });
      if (!ok) return { status: "stopped", answer: "Stopped before an action you declined." };
    }

    checkAbort(signal);
    const realPlan = { ...plan, text: fillSecrets(plan.text, secrets) };
    const result = await execute(tabId, realPlan, target, cfg);
    if (/irctc\.co\.in/i.test(obs.page.url || "") && ["click", "type", "select", "press_key"].includes(plan.action)) {
      await settle(tabId, signal);
      const r = await retryOnBusy(tabId, step, () => execute(tabId, realPlan, target, cfg), signal);
      if (r.retried) result.detail += ` (retried ${r.retried}x after IRCTC busy errors${r.stillBusy ? ", still busy" : ""})`;
    }
    emit({ type: "act", step, ok: result.ok, detail: redact(result.detail, secrets) });
    if (!result.ok) queue = [];
    // IRCTC: the class you asked for isn't bookable -> check the others and let the user choose.
    if (plan.action === "click" && /irctc\.co\.in/.test(obs.page.url || "") && /\((SL|3A|2A|1A|3E|CC|EC|2S)\)/.test(target?.label || "") && target?.id) {
      await settle(tabId, signal);
      const pick = await irctcNotAvailable(tabId, step, target, brief, signal);
      if (pick === null) return { status: "stopped", answer: "The class you asked for isn't available and you chose to stop." };
      if (pick) {
        history.push({ step, action: plan.action, id: target.id, target: target.label, result: `ok: ${result.detail}` });
        history.push({ step, action: "note", result: pick });
        continue;
      }
    }

    history.push({
      step, action: plan.action, id: target?.id,
      target: target?.label || plan.target || plan.url || plan.key || plan.direction || "",
      text: plan.text,
      result: redact(result.ok ? `ok: ${result.detail}` : `error: ${result.detail}`, secrets)
    });
    await settle(tabId, signal);
  }
  return { status: "max-steps", answer: `Stopped after ${cfg.maxSteps} steps. Raise the step limit in Settings for longer tasks.` };
}

// ---- observe ----------------------------------------------------------------
async function ensureContent(tabId) {
  try {
    const r = await chrome.tabs.sendMessage(tabId, { cmd: "ping" });
    if (r?.pong) return;
  } catch {}
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
}

/**
 * Reads the page. The screenshot (with element ids drawn on it) is only taken when something needs it:
 * Jev grounding, the done-check, or a planner that looks at images. Most steps skip it.
 */
async function observe(tabId, cfg, { shot: wantShot = false } = {}) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });

  let page;
  try {
    await ensureContent(tabId);
    page = await chrome.tabs.sendMessage(tabId, { cmd: "snapshot" });
  } catch {
    page = { url: tab.url || "", title: tab.title || "", elements: [], text: "", viewport: null, scroll: null, restricted: true };
  }

  const obs = { page, shot: null, marked: false };
  obs.capture = async () => {
    if (obs.shot || obs.tried) return obs.shot;
    obs.tried = true;
    try {
      if (cfg.setOfMark && page.elements.length && !page.restricted) {
        await chrome.tabs.sendMessage(tabId, { cmd: "marks", show: true });
        obs.marked = true;
      }
      const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      obs.shot = await prepareScreenshot(raw);
    } catch {
      obs.shot = null; // chrome:// pages, the Web Store, PDFs etc.
    } finally {
      if (obs.marked) await chrome.tabs.sendMessage(tabId, { cmd: "marks", show: false }).catch(() => {});
    }
    return obs.shot;
  };
  if (wantShot) await obs.capture();
  return obs;
}

// ---- plan (DeepSeek) ----------------------------------------------------------
const PLANNER_SYSTEM = `You plan one browser action at a time to reach the user's goal.
A separate vision model (Jev) finds the element you describe, so describe the target the way a person sees it: its visible text or label, what kind of control it is (button, link, search box), and where it sits if that tells it apart from similar ones.

Reply with one JSON object only, in this shape (include only the fields your action uses):
{"thought": "short reasoning", "action": "click", "target": "the blue Search button next to the search box", "element_hint": "e12", "text": "", "submit": false, "url": "", "key": "", "direction": "", "answer": ""}

Actions:
- click: click the element described in target.
- type: type text into the field described in target. Set submit to true to press Enter afterwards.
- select: choose the option named in text from the native dropdown described in target.
- fill: fill several fields of a form at once: {"action": "fill", "fields": [{"element_hint": "e12", "value": "Subham"}, {"element_hint": "e13", "value": "31"}, {"element_hint": "e14", "value": "Male"}]}. Text fields are typed, native dropdowns get the option named in value, checkboxes/radios are ticked ("check"/"uncheck"). Use it whenever two or more visible fields need values (passenger details, addresses). Custom dropdowns that aren't native still need click.
- hover: hover over target.
- scroll: scroll the page; direction is "up" or "down".
- navigate: open url (absolute URL).
- back: go back one page.
- press_key: press key (Enter, Escape, Tab, ArrowDown, ArrowUp) on the focused element.
- wait: wait for the page to finish loading.
- ask_user: pause until the user does something on the page (solve a captcha, enter an OTP, approve a login). Put the request in question. The run continues when they press Continue.
- handoff: stop and leave the page for the user, e.g. on a payment page or when the goal says to wait there. Put what's ready and what they must do in answer.
- done: the goal is reached. Put the result, or what you did, in answer.
- fail: the goal can't be reached. Explain why in answer.

Rules:
- Usually one action per reply. When the next few actions don't depend on the page changing in between (fill a form, tick a box, then press Continue), send up to 4 in one reply as {"thought": "...", "actions": [{"action": "fill", ...}, {"action": "click", "element_hint": "e40", "target": "..."}]}. Every action in the list needs its element_hint. Put anything that navigates or opens a popup last.
- element_hint is the [id] from the element list. Always include it when the element is in the list; it makes the agent much faster.
- If the element you need isn't in the list, scroll or navigate first.
- Don't repeat an action that already failed the same way; try another route.
- Text like {{PASSWORD}} is a secret placeholder: type it exactly as written and the agent fills in the real value.
- When the goal gives login details, log in with them. When it doesn't, never type a username or password: the browser autofills the saved login. Never type into a captcha or OTP field yourself: use ask_user.
- Never pay. When the page asks for payment (Pay & Book, Pay Now, card/UPI/net banking), use handoff.
- Don't click an element marked disabled. Something on the page must be done first (pick an option, a class, a date); do that.
- "(in: ...)" after an element tells you which card or row it belongs to; use it to pick the right one among look-alikes.
- Elements marked [off-screen above/below] can be used directly (fill, type, select, click); the agent scrolls to them. Don't scroll just to look at them.
- Before any ask_user, look again at the goal and the "Task in full"/"Values" section: if the value is there (e.g. a date of birth written next to a name), use it instead of asking.
- If a required field has no value in the goal (e.g. a last name or gender), use ask_user and ask for exactly what's missing; the reply comes back in the steps.
- FORM ERRORS: when the page lists form errors, fix every one before clicking Continue/Submit again. Tick a required checkbox, fill or correct the field the error points to (fields marked ERROR). If an error needs data the goal and the user's replies don't have (date of birth, passport, address...), ask_user ONCE for all of it together, per traveller, with the format (e.g. "Date of birth for Priya Sharma and Neha Sharma, DD/MM/YYYY"). Order for speed: if anything is missing, ask_user FIRST; then fix all errors (missing data, required checkboxes, wrong values) in ONE fill action; then Continue.
- Date of birth as Date / Month / Year searchable dropdowns: fill Date with the day number ("12"), Month with the month ("Oct" or "10"), Year with "2000". Do all three for every traveller in the same fill.
- A "Country Code" dropdown next to a mobile number: fill it with the country code digits, "91" for India (+91), unless the goal says otherwise.
- An element marked read-only opens a real input when clicked: click it once, then type into the new input in the list.
- If a field the goal mentions isn't on the page (e.g. no Food Choice for this train), skip it and move on. Don't search for it by scrolling back and forth.
- Before typing, check the field's current value in the element list; don't retype a value that is already right.
- Answer questions about the page from what it shows; don't invent facts.

${DOMAIN_NOTES}`;

function plannerUserText(goal, brief, obs, history) {
  const { page } = obs;
  const scroll = page.scroll ? (page.scroll.max ? `${Math.round((page.scroll.y / page.scroll.max) * 100)}% down the page` : "the whole page fits on screen") : "unknown";
  const lines = page.elements.map((e) => `[${e.id}] ${e.desc}`).join("\n") || "(none; the page can't be read, navigate somewhere else)";
  const hist = history.slice(-15).map((h) =>
    `${h.step}. ${h.action}${h.target ? ` ${JSON.stringify(h.target)}` : ""}${h.text ? ` text=${JSON.stringify(h.text)}` : ""} => ${h.result}`
  ).join("\n") || "(none yet)";
  return `Today: ${today()}
Goal: ${goal}
${briefText(brief)}
Page: ${page.title || "(untitled)"}
URL: ${page.url}
Scroll: ${scroll}${page.restricted ? "\nNote: this is a browser page the agent can't read or click. Use navigate." : ""}

Interactive elements in view:
${lines}
${page.errors?.length ? `
FORM ERRORS on the page (fix these before pressing Continue/Submit again):
${page.errors.map((e) => `- "${e.text}"${e.fields.length ? ` -> fields ${e.fields.join(", ")}` : ""}${e.near ? ` (near: "${e.near}")` : ""}`).join("\n")}
` : ""}

Visible text (excerpt):
${(page.text || "").slice(0, 1500)}

Steps so far:
${hist}

Choose the next action. Reply with JSON.`;
}

async function planNext(cfg, goal, brief, obs, history, signal) {
  const text = plannerUserText(goal, brief, obs, history);
  const userContent = planner(cfg).vision && obs.shot
    ? [{ type: "text", text }, { type: "image_url", image_url: { url: obs.shot.dataUrl } }]
    : text;
  const messages = [{ role: "system", content: PLANNER_SYSTEM }, { role: "user", content: userContent }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await chat(cfg, messages, { signal });
    try {
      const raw = parseJSON(r.content);
      // Several actions in one reply: run the first now, queue the rest.
      const list = Array.isArray(raw.actions) && raw.actions.length ? raw.actions.slice(0, 4) : null;
      const plan = list ? { thought: raw.thought, ...list[0] } : raw;
      if (list) {
        plan.queue = list.slice(1).filter((a) => a && ACTIONS.has(String(a.action || "").toLowerCase()) && a.element_hint)
          .map((a) => ({ ...a, action: String(a.action).toLowerCase(), thought: "(queued from the same plan)" }));
      }
      plan.action = String(plan.action || "").toLowerCase().trim();
      if (!ACTIONS.has(plan.action)) throw new Error(`unknown action "${plan.action}"`);
      if (NEEDS_TARGET.has(plan.action) && !plan.target && !plan.element_hint) throw new Error("target is missing");
      if (plan.action === "fill") {
        const ids = new Set(obs.page.elements.map((e) => e.id));
        if (!Array.isArray(plan.fields) || !plan.fields.length) throw new Error("fields is missing");
        const bad = plan.fields.filter((f) => !ids.has(f?.element_hint));
        if (bad.length) throw new Error(`fields use ids not in the element list: ${bad.map((f) => f?.element_hint).join(", ")}`);
        plan.target ||= `${plan.fields.length} fields`;
      }
      if (plan.action === "navigate" && !plan.url) throw new Error("url is missing");
      if (!plan.target && plan.element_hint) {
        plan.target = obs.page.elements.find((e) => e.id === plan.element_hint)?.desc || plan.element_hint;
      }
      return plan;
    } catch (e) {
      messages.push({ role: "assistant", content: r.content || "" });
      messages.push({ role: "user", content: `That reply was invalid (${e.message}). Reply again with one JSON object as specified.` });
    }
  }
  throw new Error("DeepSeek didn't return a usable action.");
}

// ---- ground (Jev) -------------------------------------------------------------
const STOP = new Set(["the", "and", "for", "with", "button", "link", "field", "box", "text", "click", "in", "of", "on", "to", "a", "an", "at", "top", "next", "row", "card"]);

/** The planner's element id, when it exists and its description shares a word with the target. */
function trustedHint(plan, obs) {
  if (!NEEDS_TARGET.has(plan.action) || !plan.element_hint) return null;
  const e = obs.page.elements.find((x) => x.id === plan.element_hint);
  if (!e) return null;
  const desc = e.desc.toLowerCase();
  const words = String(plan.target || "").toLowerCase().match(/[a-z0-9()]{2,}/g) || [];
  const useful = words.filter((w) => !STOP.has(w));
  if (useful.length && !useful.some((w) => desc.includes(w.replace(/[()]/g, "")))) return null;
  return { id: e.id, label: e.desc };
}
function actionText(plan) {
  const t = plan.target ? ` "${plan.target}"` : "";
  switch (plan.action) {
    case "type": return `type "${plan.text || ""}" into${t}${plan.submit ? " and press Enter" : ""}`;
    case "select": return `select "${plan.text || ""}" in${t}`;
    default: return `${plan.action}${t}`;
  }
}

async function ground(cfg, goal, plan, obs, tabId, signal) {
  await obs.capture?.();
  const { page, shot, marked } = obs;
  const els = page.elements.slice(0, 150);
  const ids = new Set(els.map((e) => e.id));
  const report = { method: null, choice: null, confidence: null, top: [], box: null, risky: null, note: null };

  const ref = shot ? newRef("screen") : null;
  const assets = shot ? { [ref]: imageAsset(shot) } : undefined;
  const state = {
    page: { url: page.url, title: page.title },
    elements: els.map((e) => ({ id: e.id, element: e.desc, at: [e.x, e.y, e.w, e.h] })),
    ...(shot ? { screenshot: ref } : {})
  };

  const questions = {
    risky: noul(
      {
        action: actionText(plan),
        question: "Would doing `action` on this page have a consequence that is hard to undo, such as buying or paying, sending or posting a message, deleting data, or submitting personal details?"
      },
      {
        true: "Hard to undo: purchase, payment, send, post, delete, or submit personal data.",
        false: "Easy to undo or read-only: navigating, searching, opening menus, filtering, typing without submitting."
      }
    )
  };

  if (els.length) {
    const criteria = Object.fromEntries(els.map((e) => [e.id, e.desc]));
    criteria.none = "None of the listed elements matches the target.";
    questions.target = choice(
      {
        goal,
        action: plan.action,
        target: plan.target,
        ...(plan.text ? { text: plan.text } : {}),
        question: `Which element in \`elements\` is \`target\`, the one to ${plan.action}?` +
          (shot ? (marked
            ? " `screenshot` shows the same page; each listed element has a blue outline with its id in a small label at its top-left corner."
            : " `screenshot` shows the same page; `at` gives each element's [x, y, width, height] in page pixels.") : "")
      },
      criteria
    );
  }

  let target = null;
  let risky = null;
  try {
    const res = await systemOne(cfg, { model: cfg.jevModel, state, questions, assets }, { signal });
    risky = answerOf(res, "risky", "noul").noul;
    report.risky = risky;
    if (questions.target) {
      const a = answerOf(res, "target", "choice");
      report.method = "choice";
      report.choice = a.choice;
      report.confidence = a.confidence;
      report.top = Object.entries(a.probabilities).sort((x, y) => y[1] - x[1]).slice(0, 3)
        .map(([id, p]) => ({ id, p, label: id === "none" ? "none of these" : (els.find((e) => e.id === id)?.desc || id) }));
      const agrees = plan.element_hint && plan.element_hint === a.choice;
      if (a.choice !== "none" && ids.has(a.choice) && (a.confidence >= cfg.choiceThreshold || agrees)) {
        const e = els.find((x) => x.id === a.choice);
        target = { id: a.choice, label: e.desc };
        if (agrees && a.confidence < cfg.choiceThreshold) report.note = "Low confidence, but matches the planner's pick.";
      }
    }
  } catch (e) {
    if (signal.aborted) throw e;
    report.note = `Jev choice failed: ${e.message}`;
  }

  // Fallback: find it on the screenshot with a Box question (Jev 1.14).
  if (!target && cfg.useBox && shot && page.viewport) {
    try {
      const bref = newRef("screen");
      const res = await systemOne(cfg, {
        model: cfg.boxModel,
        state: { screenshot: bref },
        assets: { [bref]: imageAsset(shot) },
        questions: {
          visible: noul(`Is this visible in \`screenshot\`: ${plan.target}?`),
          where: box(`${plan.target} in \`screenshot\``)
        }
      }, { signal });
      const vis = answerOf(res, "visible", "noul").noul;
      const b = answerOf(res, "where", "box");
      report.method = report.method ? `${report.method}+box` : "box";
      report.box = { ...b.box, confidence: b.confidence, visible: vis };
      if (vis >= 0.5 && b.confidence >= cfg.boxThreshold) {
        const cxPx = ((b.box.left + b.box.right) / 2) * shot.width;
        const cyPx = ((b.box.top + b.box.bottom) / 2) * shot.height;
        if (cxPx <= shot.contentWidth && cyPx <= shot.contentHeight) {
          const x = (cxPx / shot.contentWidth) * page.viewport.w;
          const y = (cyPx / shot.contentHeight) * page.viewport.h;
          const info = await chrome.tabs.sendMessage(tabId, { cmd: "point", x, y }).catch(() => null);
          target = { id: info?.id, point: { x, y }, label: info?.desc || `point (${Math.round(x)}, ${Math.round(y)})` };
        }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      report.note = (report.note ? report.note + " " : "") + `Jev box failed: ${e.message}`;
    }
  }

  // Last resort: trust the planner's id.
  if (!target && plan.element_hint && ids.has(plan.element_hint)) {
    const e = els.find((x) => x.id === plan.element_hint);
    target = { id: e.id, label: e.desc };
    report.method = (report.method ? report.method + "+" : "") + "planner";
    report.note = (report.note ? report.note + " " : "") + "Used the planner's element id.";
  }

  report.target = target ? { id: target.id || null, label: target.label } : null;
  return { target, risky, report };
}

// ---- verify (Jev) -------------------------------------------------------------
async function verifyDone(cfg, goal, plan, obs, signal) {
  await obs.capture?.();
  const ref = obs.shot ? newRef("screen") : null;
  const res = await systemOne(cfg, {
    model: cfg.jevModel,
    state: {
      page: { url: obs.page.url, title: obs.page.title, text: (obs.page.text || "").slice(0, 2000) },
      ...(ref ? { screenshot: ref } : {})
    },
    assets: ref ? { [ref]: imageAsset(obs.shot) } : undefined,
    questions: {
      achieved: noul({
        goal,
        reported_result: plan.answer || plan.thought || "",
        question: `Looking at \`page\`${ref ? " and `screenshot`" : ""}, has \`goal\` been accomplished, and is \`reported_result\` consistent with what the page shows?`
      })
    }
  }, { signal });
  return answerOf(res, "achieved", "noul").noul;
}

// ---- act ----------------------------------------------------------------------
// ---- real input through chrome.debugger -----------------------------------------
// Many sites ignore script-made clicks (MakeMyTrip's From box never opens). Input sent through the
// DevTools protocol is trusted, exactly like a person's mouse and keyboard.
const attached = new Set();
chrome.debugger?.onDetach.addListener((src) => attached.delete(src.tabId));

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached.add(tabId);
  }
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function detachAll() {
  for (const tabId of attached) await chrome.debugger.detach({ tabId }).catch(() => {});
  attached.clear();
}

async function realClick(tabId, x, y) {
  const base = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x: base.x, y: base.y });
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await sleep(40);
  await cdp(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

const KEYS = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" }, Escape: { code: "Escape", keyCode: 27 }, Tab: { code: "Tab", keyCode: 9 },
  Backspace: { code: "Backspace", keyCode: 8 }, ArrowDown: { code: "ArrowDown", keyCode: 40 }, ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 }, ArrowRight: { code: "ArrowRight", keyCode: 39 }, Space: { code: "Space", keyCode: 32, text: " " }
};

async function realKey(tabId, key) {
  const k = KEYS[key] || { code: key, keyCode: 0 };
  const name = key === "Space" ? " " : key;
  await cdp(tabId, "Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key: name, code: k.code, windowsVirtualKeyCode: k.keyCode, ...(k.text ? { text: k.text } : {}) });
  await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: name, code: k.code, windowsVirtualKeyCode: k.keyCode });
}

async function realType(tabId, text) {
  for (const ch of text) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(25);
  }
}

/**
 * Types into field `id` with real keys: makes sure it has focus (pages jump when a sticky header
 * appears), clears it, types, and checks the value stuck. Searchable dropdowns get an Enter.
 */
async function typeReal(tabId, id, text, page) {
  for (let i = 0; i < 2; i++) {
    const c = await page({ cmd: "focusCheck", id });
    if (!c?.ok) return { ok: false, note: "the field disappeared" };
    if (c.focused) break;
    if (i === 0) { await realClick(tabId, c.x, c.y); await sleep(150); }
    else await page({ cmd: "forceFocus", id });
  }
  await page({ cmd: "clearField", id });
  await realType(tabId, text);
  await sleep(200);
  let v = await page({ cmd: "valueOf", id }).catch(() => null);
  if (v?.searchable) {
    await sleep(300);
    await realKey(tabId, "Enter");
    return { ok: true, note: "picked the matching option with Enter" };
  }
  if (v && "value" in v && v.value.trim() !== text.trim() && !/^\{\{/.test(text)) {
    return { ok: false, note: `the field now shows "${String(v.value).slice(0, 40)}"; the site may reformat it or reject it` };
  }
  return { ok: true };
}

/** Fills a form with real keystrokes; dropdowns and radios still go through the page script. */
async function fillReal(tabId, fields) {
  const page = (msg) => chrome.tabs.sendMessage(tabId, msg);
  try { await cdp(tabId, "Runtime.evaluate", { expression: "1" }); } catch { return null; }
  const plan = await page({ cmd: "fillPlan", fields });
  const done = [], failed = [], rest = [];
  for (const [i, p] of plan.entries()) {
    const f = fields[i];
    if (p.kind !== "text") { rest.push(f); continue; }
    const loc = await page({ cmd: "locate", id: p.id });
    if (!loc?.ok) { failed.push(`${f.id}: gone`); continue; }
    await realClick(tabId, loc.x, loc.y);
    await sleep(80);
    const r = await typeReal(tabId, p.id, String(f.value ?? ""), page);
    (r.ok ? done : failed).push(`${f.id} = "${String(f.value).slice(0, 30)}"${r.note ? ` (${r.note})` : ""}`);
  }
  let other = null;
  if (rest.length) other = await page({ cmd: "fill", fields: rest }).catch((e) => ({ ok: false, detail: e.message }));
  const ok = failed.length === 0 && (!other || other.ok);
  return { ok, detail: [done.length ? `typed ${done.join("; ")}` : "", failed.length ? `FAILED ${failed.join("; ")}` : "", other?.detail || ""].filter(Boolean).join(". ") };
}

/** click / type / press_key with real input. Returns null when the debugger can't be used. */
async function executeReal(tabId, plan, target) {
  const page = (msg) => chrome.tabs.sendMessage(tabId, msg);
  try {
    await cdp(tabId, "Runtime.evaluate", { expression: "1" }); // attaches, or throws (DevTools open, chrome:// page)
  } catch {
    return null;
  }
  await ensureContent(tabId);
  switch (plan.action) {
    case "click": {
      const loc = await page({ cmd: "locate", id: target?.id, point: target?.point });
      if (!loc?.ok) return { ok: false, detail: loc?.detail || "target not found" };
      await realClick(tabId, loc.x, loc.y);
      return { ok: true, detail: `clicked ${loc.desc}` };
    }
    case "press_key":
      await realKey(tabId, plan.key || "Enter");
      return { ok: true, detail: `pressed ${plan.key || "Enter"}` };
    case "type": {
      let f = await page({ cmd: "prepType", id: target?.id, point: target?.point });
      if (!f?.ok) return { ok: false, detail: f?.detail || "no text field" };
      if (f.searchable) return null; // the page-side picker opens it, filters and clicks the option, and verifies

      if (f.readonly) {
        // MakeMyTrip-style box: a real click opens the actual input.
        await realClick(tabId, f.x, f.y);
        await sleep(300);
        f = await page({ cmd: "openedInput", id: f.id });
        if (!f?.ok) return { ok: false, detail: `${f?.detail || "no input opened"} Try clicking the box, then type into the new input.` };
      } else {
        await realClick(tabId, f.x, f.y);
      }
      const typed = await typeReal(tabId, f.id, String(plan.text ?? ""), page);
      if (plan.submit) await realKey(tabId, "Enter");
      await sleep(250);
      const info = await page({ cmd: "typedInfo", id: f.id }).catch(() => null);
      return {
        ok: typed.ok,
        detail: `${typed.ok ? "typed" : "tried to type"} "${String(plan.text ?? "").slice(0, 60)}" into ${info?.desc || "the field"}${plan.submit ? " and pressed Enter" : ""}${typed.note ? `. ${typed.note}` : ""}${info?.picks ? `; ${info.picks} suggestions are showing, click the right one` : ""}`
      };
    }
  }
  return null;
}

async function execute(tabId, plan, target, cfg) {
  try {
    if (cfg?.trustedInput && ["click", "type", "press_key"].includes(plan.action)) {
      const r = await executeReal(tabId, plan, target);
      if (r) return r;
    }
    switch (plan.action) {
      case "navigate": {
        let url = String(plan.url).trim();
        if (!/^[a-z]+:/i.test(url)) url = "https://" + url;
        await chrome.tabs.update(tabId, { url });
        return { ok: true, detail: `opened ${url}` };
      }
      case "back":
        await chrome.tabs.goBack(tabId);
        return { ok: true, detail: "went back" };
      case "wait":
        await sleep(1000);
        return { ok: true, detail: "waited" };
      default: {
        await ensureContent(tabId);
        const r = await chrome.tabs.sendMessage(tabId, {
          cmd: "act",
          action: {
            type: plan.action, id: target?.id, point: target?.point,
            text: plan.text, submit: !!plan.submit, key: plan.key, direction: plan.direction
          }
        });
        return r || { ok: true, detail: "done (page changed)" };
      }
    }
  } catch (e) {
    // A click that navigates can close the message channel before it replies.
    if (/message port closed|receiving end does not exist/i.test(e.message)) return { ok: true, detail: "done (page changed)" };
    return { ok: false, detail: e.message };
  }
}

async function settle(tabId, signal) {
  await sleep(200);
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    checkAbort(signal);
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t || t.status === "complete") break;
    await sleep(150);
  }
  await sleep(150);
  // Single-page apps (IRCTC and co.) show a spinner while they fetch.
  const busyEnd = Date.now() + 10000;
  while (Date.now() < busyEnd) {
    checkAbort(signal);
    const busy = await chrome.tabs.sendMessage(tabId, { cmd: "busy" }).catch(() => false);
    if (!busy) break;
    await sleep(200);
  }
}

// ---- confirmation -------------------------------------------------------------
function summarize(plan, target) {
  const what = target?.label || plan.target || "";
  if (plan.action === "type") return `Type "${plan.text || ""}" into ${what}${plan.submit ? " and press Enter" : ""}`;
  if (plan.action === "select") return `Select "${plan.text || ""}" in ${what}`;
  return `${plan.action[0].toUpperCase()}${plan.action.slice(1)} ${what}`;
}

function askUser({ step, question, auto = false, watch }) {
  const id = crypto.randomUUID();
  emit({ type: "ask", id, step, question, auto });
  const stopWatch = new AbortController();
  const p = new Promise((resolve) => {
    pendingAsks.set(id, (v) => {
      pendingAsks.delete(id);
      stopWatch.abort();
      emit({ type: "ask-resolved", id, reply: v });
      resolve(v);
    });
  });
  watch?.(stopWatch.signal).then((v) => { if (v != null) pendingAsks.get(id)?.(v); }, () => {});
  return p;
}

const AUTO = "\u0000captcha-typed";
const LOGGED_IN = "\u0000login-submitted";

/**
 * Signs in on a visible login form. Uses what's in the boxes (typed by the agent or filled by
 * Chrome's saved logins), waits only for what's missing, then presses SIGN IN itself.
 * Chrome won't let a page read a saved password until the person has clicked or typed on it,
 * so with no captcha to type the user may be asked for one click on the page.
 * @returns {Promise<string|null>} LOGGED_IN, AUTO (form gone), or null if stopped
 */
async function loginFlow(tabId, step, signal) {
  const info = () => chrome.tabs.sendMessage(tabId, { cmd: "loginInfo" }).catch(() => null);
  for (let round = 0; round < 4; round++) {
    checkAbort(signal);
    const s = await info();
    if (!s) return AUTO; // the form closed: signed in already
    const needCaptcha = s.captcha && s.captcha.length < 4;
    const needLogin = !s.password.readable || !s.user;
    if (!needCaptcha && !needLogin) {
      const r = await chrome.tabs.sendMessage(tabId, { cmd: "submitLogin" }).catch((e) => ({ ok: false, detail: e.message }));
      emit({ type: "act", step, ok: r.ok, detail: r.ok ? `Signed in: ${r.detail}` : r.detail });
      return r.ok ? LOGGED_IN : null;
    }
    if (needCaptcha) await chrome.tabs.sendMessage(tabId, { cmd: "loginState", focus: true }).catch(() => null);
    const question = needCaptcha
      ? (needLogin && !s.password.filled
          ? "Pick your saved login in the username box, then type the captcha. The agent signs in by itself."
          : "Type the captcha on the page. The agent signs in by itself.")
      : s.password.filled
        ? "Click once anywhere on the login box. Chrome only hands your saved password to the page after you touch it. The agent signs in by itself."
        : "Pick your saved login in the username box (or type it). The agent signs in by itself.";
    const reply = await askUser({
      step, question, auto: true,
      watch: async (stop) => {
        let last = "", since = 0;
        while (!stop.aborted && !signal.aborted) {
          await sleep(400);
          const t = await info();
          if (!t) return AUTO;
          const ready = (!t.captcha || t.captcha.length >= 4) && t.password.readable && t.user > 0;
          const key = `${t.captcha?.length}|${t.password.readable}|${t.user}`;
          if (key !== last) { last = key; since = Date.now(); continue; }
          if (ready && Date.now() - since >= (t.captcha ? 1500 : 300)) return AUTO;
        }
        return null;
      }
    });
    if (reply == null) return null;
    if (reply !== AUTO) continue; // user pressed Continue in the panel: re-check
  }
  return null;
}

/**
 * Hands the page to the user for a captcha/OTP. When the page has a captcha box, the cursor
 * goes into it and the run carries on by itself once the user has typed it (no Continue click).
 * @returns {Promise<string|null>} AUTO, the user's note, or null if stopped
 */
async function waitForHuman(tabId, step, question, signal) {
  if (await chrome.tabs.sendMessage(tabId, { cmd: "loginInfo" }).catch(() => null)) return loginFlow(tabId, step, signal);
  const state = await chrome.tabs.sendMessage(tabId, { cmd: "loginState", focus: true }).catch(() => null);
  if (!state?.captcha) return askUser({ step, question });

  const needsLogin = state.password && !state.password.filled;
  const ask = needsLogin
    ? "Type the captcha on the page. If your saved login isn't filled in, click the username box and pick it. The agent carries on by itself."
    : "Type the captcha on the page. The agent carries on by itself once it's typed.";
  return askUser({
    step, question: ask, auto: true,
    watch: async (stop) => {
      let last = "", since = 0;
      while (!stop.aborted && !signal.aborted) {
        await sleep(400);
        const s = await chrome.tabs.sendMessage(tabId, { cmd: "loginState" }).catch(() => null);
        if (!s?.captcha) return s ? AUTO : null; // dialog closed (user signed in themselves) or tab gone
        const key = `${s.captcha.length}|${s.password?.filled ?? ""}`;
        const ready = s.captcha.length >= 4 && (!s.password || s.password.filled);
        if (key !== last) { last = key; since = Date.now(); continue; }
        // Unchanged for 1.5 s: they've finished typing.
        if (ready && Date.now() - since >= 1500) return AUTO;
      }
      return null;
    }
  });
}

function askConfirm({ step, probability, summary }) {
  const id = crypto.randomUUID();
  emit({ type: "confirm", id, step, probability, summary });
  return new Promise((resolve) => {
    pendingConfirms.set(id, (v) => {
      pendingConfirms.delete(id);
      emit({ type: "confirm-resolved", id, approve: v });
      resolve(v);
    });
  });
}

// Injected on demand. Safe to inject more than once: state persists on window,
// and the message listener is replaced so a reloaded extension re-attaches cleanly.
(() => {
  const S = (window.__jevState ||= { ids: new WeakMap(), byId: new Map(), counter: 0, last: null, markRoot: null });

  const SELECTOR = [
    "a[href]", "button", "input:not([type=hidden])", "textarea", "select", "summary",
    "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]", "[role=checkbox]", "[role=radio]",
    "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[role=gridcell][aria-label]:not([aria-disabled=true])",
    "[contenteditable='']", "[contenteditable=true]", "[onclick]", "[tabindex]:not([tabindex='-1'])"
  ].join(",");
  const MAX_ELEMENTS = 200;
  const OWN_RIGHT = /^(INPUT|SELECT|TEXTAREA)$/;
  const ACTION_TEXT = /^\+?\s*(add|continue|proceed|submit|next|book|skip|confirm|done|apply|search|save|review)\b/i;
  const LEAF = /^(link|button|option|menuitem|tab|checkbox|radio|switch)$/;
  const FORM_FIELDS = "input:not([type=hidden]), select, textarea, [role=combobox], p-dropdown .p-dropdown, .p-dropdown, button[type=submit], button.train_Search";
  // Framework click handlers (Angular, React) leave no attribute behind; cursor:pointer is the tell.
  const POINTER_CANDIDATES = "a:not([href]),div,span,li,td,th,label,p,strong,b,img,svg,i";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s, n = 80) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);

  function idFor(el) {
    let id = S.ids.get(el);
    if (!id) { id = "e" + ++S.counter; S.ids.set(el, id); }
    S.byId.set(id, new WeakRef(el));
    return id;
  }
  function byId(id) {
    const el = S.byId.get(id)?.deref();
    return el && el.isConnected ? el : null;
  }

  /** A styled radio/checkbox is often invisible (opacity 0) behind its label; the label is what to click. */
  function hitTarget(el) {
    if (el.tagName === "INPUT" && (el.type === "radio" || el.type === "checkbox")) {
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const hidden = parseFloat(cs.opacity) === 0 || r.width < 3 || r.height < 3 || cs.visibility === "hidden";
      const lab = el.labels?.[0] || el.closest("label");
      if (hidden && lab && lab.getBoundingClientRect().width > 3) return lab;
    }
    // react-select and co.: the typing box is ~2px wide; the dropdown around it is what people click.
    if (el.tagName === "INPUT" && (el.getAttribute("aria-autocomplete") === "list" || el.getAttribute("role") === "combobox")) {
      const r = el.getBoundingClientRect();
      if (r.width < 10) {
        // Climb to the first wrapper a person can actually see (react-select nests the input 3 tiny divs deep).
        for (let p = el.parentElement, d = 0; p && p !== document.body && d < 6; p = p.parentElement, d++) {
          if (p.getBoundingClientRect().width > 20) return p.closest("[class*='__control'], [class*='-control']") || p;
        }
      }
    }
    return el;
  }

  function visibleRect(el) {
    const hit = hitTarget(el);
    if (hit !== el) return visibleRect(hit);
    const r = el.getBoundingClientRect();
    if (r.width < 3 || r.height < 3) return null;
    if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) return null;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || parseFloat(cs.opacity) === 0) return null;
    return r;
  }

  function kindOf(el) {
    const role = el.getAttribute("role");
    if (role) return role;
    const t = el.tagName.toLowerCase();
    if (t === "a") return "link";
    if (t === "input") {
      const ty = (el.type || "text").toLowerCase();
      if (["button", "submit", "reset", "image"].includes(ty)) return "button";
      if (ty === "checkbox" || ty === "radio") return ty;
      return ty === "text" ? "text field" : `${ty} field`;
    }
    if (t === "textarea") return "text area";
    if (t === "select") return "dropdown";
    if (t === "summary") return "button";
    if (el.isContentEditable) return "editable text";
    if (getComputedStyle(el).cursor === "pointer") return "clickable box";
    return t;
  }

  function labelOf(el) {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const t = lb.split(/\s+/).map((i) => document.getElementById(i)?.innerText || "").join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.labels?.[0]) return clean(el.labels[0].innerText);
    const text = clean(el.innerText);
    if (text) return text;
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type) && el.value) return clean(el.value);
    const img = el.querySelector?.("img[alt]");
    if (img?.alt) return clean(img.alt);
    const own = clean(el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || "");
    if (own) return own;
    // Searchable dropdown inputs (react-select) are blank; the visible "Date"/"Month" text sits in the control.
    if (el.tagName === "INPUT") {
      const ctl = el.closest("[class*='__control'], [class*='-control'], [class*='dropdown' i]");
      if (ctl) return clean(ctl.innerText, 40);
    }
    return "";
  }

  function describe(el) {
    const kind = kindOf(el);
    const parts = [kind];
    const label = labelOf(el);
    if (label) parts.push(`"${label}"`);
    if (el.placeholder) parts.push(`placeholder "${clean(el.placeholder, 40)}"`);
    if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "password" && el.value && !["button", "submit", "reset"].includes(el.type) && !(/^(radio|checkbox)$/.test(el.type) && el.value === "on"))
      parts.push(`value "${clean(el.value, 40)}"`);
    if (el.tagName === "SELECT" && el.selectedOptions?.[0]) parts.push(`selected "${clean(el.selectedOptions[0].text, 40)}"`);
    if (el.tagName === "SELECT") parts.push(`options: ${[...el.options].map((o) => clean(o.text, 20)).filter(Boolean).slice(0, 8).join(" | ")}`);
    const fc = el.getAttribute("formcontrolname");
    if (fc && !labelOf(el)) parts.push(`(${fc})`);
    // "1", "2" in a traveller picker mean nothing alone; the page's own tag (adults-2) does.
    const tag = el.getAttribute("data-cy") || el.getAttribute("data-testid") || el.getAttribute("data-test-id");
    if (tag && label.replace(/[^\w]/g, "").length <= 3) parts.push(`[${clean(tag, 30)}]`);
    if (isSearchable(el)) parts.push("(searchable dropdown: fill/type the option text, e.g. 12, Oct, 2000, 91)");
    if (el.checked) parts.push("checked");
    // A clickable label beside a hidden checkbox (MakeMyTrip's billing box): say whether it's ticked.
    if (el.tagName !== "INPUT" && kind === "clickable box") {
      const boxes = el.parentElement?.querySelectorAll("input[type=checkbox]");
      if (boxes?.length === 1 && !el.contains(boxes[0])) parts.push(boxes[0].checked ? "checked" : "unchecked");
    }
    if (el.readOnly && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) parts.push("read-only (click it to open the real input)");
    if (el.disabled || el.getAttribute("aria-disabled") === "true" || /(^|[\s_-])disabled?([\s_-]|$)|disable-?btn/i.test(el.getAttribute("class") || ""))
      parts.push("disabled");
    if (el.getAttribute("aria-expanded")) parts.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (kind === "link" && el.href) {
      try { const u = new URL(el.href); parts.push(`href ${u.host === location.host ? u.pathname + u.search : u.host + u.pathname}`.slice(0, 90)); } catch {}
    }
    return parts.join(" ");
  }

  function pointerTargets() {
    const out = [];
    for (const el of document.body?.querySelectorAll(POINTER_CANDIDATES) || []) {
      if (el.matches(SELECTOR) || el.closest(SELECTOR)) continue;
      if (getComputedStyle(el).cursor !== "pointer") continue;
      // Only the outermost pointer element: the box, not the label and icon inside it.
      const p = el.parentElement;
      // ...unless the parent holds more than this one item (a calendar row holding day cells).
      if (p && p !== document.body && getComputedStyle(p).cursor === "pointer" && clean(p.innerText) === clean(el.innerText)) continue;
      if (!clean(el.innerText) && !el.getAttribute("aria-label") && !el.getAttribute("title")) continue;
      out.push(el);
    }
    return out;
  }

  function snapshot() {
    const elements = [];
    const included = new Set();
    for (const el of [...document.querySelectorAll(SELECTOR), ...pointerTargets()]) {
      if (elements.length >= MAX_ELEMENTS) break;
      const r = visibleRect(el);
      if (!r) continue;
      // Skip an element nested inside a simple control already listed (e.g. <a><button>), but keep
      // fields and options inside containers (a combobox popup holding the real search box).
      if (!OWN_RIGHT.test(el.tagName) && !/^(option|textbox|searchbox|combobox|checkbox|radio)$/.test(el.getAttribute("role") || "")) {
        let p = el.parentElement, dup = false;
        const area = (x) => { const b = x.getBoundingClientRect(); return b.width * b.height; };
        for (let d = 0; p && d < 4; d++, p = p.parentElement)
          if (included.has(p) && LEAF.test(kindOf(p)) && area(p) < 3 * area(el)) { dup = true; break; } // same control, not a card holding a button
        if (dup) continue;
      }
      included.add(el);
      elements.push({
        id: idFor(el), desc: describe(el),
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
      });
    }
    elements.sort((a, b) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y));
    // Form fields outside the viewport too, so a long form can be filled without scrolling around it.
    for (const el of document.querySelectorAll(FORM_FIELDS)) {
      if (elements.length >= MAX_ELEMENTS) break;
      if (included.has(el) || visibleRect(el)) continue;
      // Measure what a person sees: the dropdown box around a 2px search input, the label of a hidden radio.
      const r = hitTarget(el).getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const cs = getComputedStyle(hitTarget(el));
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      let p = el.parentElement, dup = false;
      for (let d = 0; p && d < 4; d++, p = p.parentElement) if (included.has(p)) { dup = true; break; }
      if (dup) continue;
      included.add(el);
      elements.push({
        id: idFor(el), desc: `${describe(el)} [off-screen ${r.top < 0 ? "above" : "below"}]`,
        x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), offscreen: true
      });
    }
    // Action buttons outside the viewport too (+ ADD NEW ADULT, CONTINUE), so the agent needn't hunt for them.
    let extra = 0;
    for (const el of document.querySelectorAll("button, a, [role=button], [class*='btn' i]")) {
      if (elements.length >= MAX_ELEMENTS || extra >= 15) break;
      if (included.has(el) || visibleRect(el)) continue;
      const t = clean(el.innerText, 40);
      if (!ACTION_TEXT.test(t)) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 3 || r.height < 3) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none") continue;
      let p = el.parentElement, dup = false;
      for (let d = 0; p && d < 4; d++, p = p.parentElement) if (included.has(p)) { dup = true; break; }
      if (dup) continue;
      included.add(el);
      extra++;
      elements.push({ id: idFor(el), desc: `${describe(el)} [off-screen ${r.top < 0 ? "above" : "below"}]`, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), offscreen: true });
    }
    addContext(elements);
    const errors = formErrors(elements);
    const docH = document.documentElement.scrollHeight;
    S.last = {
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      scroll: { y: Math.round(scrollY), max: Math.max(0, docH - innerHeight) },
      elements,
      errors,
      text: clean(document.body?.innerText, 2500)
    };
    return S.last;
  }

  // ---- form validation errors -------------------------------------------------
  const ERROR_SEL = "[class*='error' i], [class*='invalid' i], [class*='Err'], [role=alert], [aria-live=assertive], .help-block, .text-danger";
  const ERROR_TEXT = /required|invalid|enter|please|must|select|error|incorrect|valid|confirm|missing|mandatory|cannot|can't|should/i;
  const CONTROLS = "input:not([type=hidden]), select, textarea, [role=combobox], [role=checkbox], [role=radio]";

  /** Visible validation messages, each tied to the form fields it sits next to. Marks those fields. */
  function formErrors(elements) {
    const seen = new Set(), out = [];
    const listed = new Map(elements.map((e) => [e.id, e]));
    const consider = (el, text) => {
      text = clean(text, 140);
      if (!text || text.length < 4 || seen.has(text) || !ERROR_TEXT.test(text)) return;
      seen.add(text);
      // The nearest container that also holds form fields: those are the ones to fix.
      let box = el.parentElement, fields = [];
      const lab = el.closest("label");
      // A clickable message is itself the control (MakeMyTrip's "Confirm and save billing details" is a styled <p>).
      const own = lab?.control || lab?.querySelector(CONTROLS) || el.querySelector(CONTROLS) || (getComputedStyle(el).cursor === "pointer" ? el : null);
      if (own) { fields = [own]; box = lab || el; }
      else for (let d = 0; box && box !== document.body && d < 5; d++, box = box.parentElement) {
        fields = [...box.querySelectorAll(CONTROLS)].filter((f) => f.getBoundingClientRect().width > 0 || hitTarget(f) !== f);
        if (fields.length) break;
      }
      const ids = fields.slice(0, 6).map((f) => idFor(f));
      // Fields an error points at must be in the list, wherever they are on the page.
      for (const f of fields.slice(0, 6)) {
        const id = idFor(f);
        if (listed.has(id)) continue;
        const r = hitTarget(f).getBoundingClientRect();
        if (r.width < 3 || r.height < 3) continue;
        const where = r.bottom <= 0 ? " [off-screen above]" : r.top >= innerHeight ? " [off-screen below]" : "";
        const e = { id, desc: describe(f) + where, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        elements.push(e);
        listed.set(id, e);
      }
      for (const id of ids) {
        const e = listed.get(id);
        if (e && !e.desc.includes("ERROR:")) e.desc += ` ERROR: "${clean(text, 60)}"`;
      }
      out.push({ text, near: box ? clean(box.innerText, 80) : "", fields: ids.filter((id) => listed.has(id)) });
    };
    for (const el of document.querySelectorAll(ERROR_SEL)) {
      if (out.length >= 12) break;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || el.children.length > 4) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (el.matches(CONTROLS)) continue;
      consider(el, el.innerText);
    }
    for (const f of document.querySelectorAll("[aria-invalid=true]")) {
      if (out.length >= 12) break;
      if (f.getBoundingClientRect().width < 2) continue;
      consider(f, `${labelOf(f) || f.placeholder || "field"} is invalid`);
    }
    return out;
  }

  // Repeated controls ("Book Now", "3A", "Refresh") get the text of the card they sit in,
  // so the planner can tell which train row or product they belong to.
  function addContext(elements) {
    const count = new Map();
    for (const e of elements) count.set(e.desc, (count.get(e.desc) || 0) + 1);
    for (const e of elements) {
      if (count.get(e.desc) < 2) continue;
      const el = byId(e.id);
      const own = clean(el?.innerText, 200);
      if (!own && el) {
        // Inputs have no text: climb while the ancestor holds just this one look-alike field.
        const same = (x) => x.tagName === el.tagName && x.type === el.type && (x.placeholder || "") === (el.placeholder || "") && (x.name || "") === (el.name || "") && (!/^(radio|checkbox)$/.test(el.type) || x.value === el.value) && labelOf(x) === labelOf(el);
        let card = null;
        for (let p = el.parentElement, d = 0; p && p !== document.body && d < 12; p = p.parentElement, d++) {
          if ([...p.querySelectorAll(el.tagName)].filter(same).length > 1) break;
          const t = clean(p.innerText, 300);
          if (t) card = t;
        }
        if (card) e.desc += ` (in: "${clean(card, 60)}")`;
        continue;
      }
      if (!own) continue;
      // Climb while the ancestor still holds just one copy of this label: that's its card/row.
      let card = null;
      for (let p = el.parentElement, d = 0; p && p !== document.body && d < 12; p = p.parentElement, d++) {
        const t = clean(p.innerText, 100000);
        if (t.split(own).length - 1 > 1) break;
        if (t.length > own.length + 15) card = t;
      }
      if (card) e.desc += ` (in: "${clean(card.replace(own, ""), 80)}")`;
    }
  }

  // Login/captcha watch. Reads only lengths and whether a field is filled, never values.
  const CAPTCHA_FIELD = /captcha|security code|verification code|enter the text/i;
  const fieldInfo = (el) =>
    [el.placeholder, el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("formcontrolname"), el.labels?.[0]?.innerText].join(" ");
  function loginState(focus) {
    const inputs = [...document.querySelectorAll("input")].filter((el) => visibleRect(el) && !el.disabled);
    const cap = inputs.find((el) => el.type !== "password" && CAPTCHA_FIELD.test(fieldInfo(el)));
    if (!cap) return { captcha: null };
    const pw = inputs.find((el) => el.type === "password");
    let autofilled = false;
    try { autofilled = !!pw && (pw.matches(":autofill") || pw.matches(":-webkit-autofill")); } catch {}
    if (focus && document.activeElement !== cap) {
      cap.scrollIntoView({ block: "center", behavior: "instant" });
      cap.focus();
    }
    return {
      captcha: { length: cap.value.length },
      password: pw ? { filled: autofilled || pw.value.length > 0, readable: pw.value.length > 0 } : null
    };
  }

  /** Login form with a password box, whether or not it has a captcha. Lengths only, never values. */
  function loginForm() {
    const pw = [...document.querySelectorAll("input[type=password]")].find((el) => visibleRect(el) && !el.disabled);
    if (!pw) return null;
    const box = pw.closest("form, [role=dialog], .p-dialog, .ui-dialog, app-login") || document.body;
    const cap = [...box.querySelectorAll("input")].find((el) => el.type !== "password" && visibleRect(el) && CAPTCHA_FIELD.test(fieldInfo(el)));
    const user = [...box.querySelectorAll("input")].find((el) => el !== cap && visibleRect(el) && /^(text|email|tel|)$/.test(el.type) && !CAPTCHA_FIELD.test(fieldInfo(el)));
    let autofilled = false;
    try { autofilled = pw.matches(":autofill") || pw.matches(":-webkit-autofill"); } catch {}
    return { pw, box, cap, user, autofilled };
  }

  function loginInfo() {
    const f = loginForm();
    if (!f) return null;
    return {
      user: f.user ? f.user.value.length : 0,
      password: { filled: f.autofilled || f.pw.value.length > 0, readable: f.pw.value.length > 0 },
      captcha: f.cap ? { length: f.cap.value.length } : null
    };
  }

  /**
   * Chrome shows saved logins before the page can read them, and Angular only learns a value from
   * input events. Re-announce what's in the boxes, then press the form's sign-in button.
   */
  async function submitLogin() {
    const f = loginForm();
    if (!f) return { ok: false, detail: "no login form" };
    for (const el of [f.user, f.pw, f.cap]) {
      if (!el || !el.value) continue;
      el.dispatchEvent(new Event("focus"));
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur"));
    }
    await sleep(100);
    const btn = [...f.box.querySelectorAll("button, input[type=submit], a")]
      .find((b) => shown(b) && /^(sign ?in|log ?in|login|submit)$/i.test(clean(b.innerText || b.value)));
    if (!btn) return { ok: false, detail: "sign-in button not found" };
    clickEl(btn);
    return { ok: true, detail: `pressed ${clean(btn.innerText || btn.value)}` };
  }

  // ---- error toasts (IRCTC's top-right "Server busy" / "Unable to process" popups) ----
  const TOAST_SEL = ".ui-toast-message, .p-toast-message, .ui-growl-message, .p-growl-message, .ui-messages-error, .toast-error, [class*='toast' i] [role=alert], .ui-toast [role=alert], .p-toast [role=alert]";
  function errorToasts() {
    const seen = new Set();
    for (const el of document.querySelectorAll(TOAST_SEL)) {
      if (!shown(el)) continue;
      const t = clean(el.innerText, 160);
      if (t) seen.add(t);
    }
    return [...seen];
  }
  function dismissToasts() {
    for (const el of document.querySelectorAll(TOAST_SEL)) {
      const x = el.querySelector(".ui-toast-close-icon, .p-toast-icon-close, .ui-growl-icon-close, [class*='close' i]");
      if (x) clickEl(x);
      el.style.display = "none"; // don't let a stale toast look like a new one
    }
    return true;
  }

  const BUSY = "[aria-busy=true], #loaderP, .my-loading, .loader, .spinner, .loading-overlay, [class*='spinner'], [class*='Spinner']";
  function busy() {
    for (const el of document.querySelectorAll(BUSY)) {
      const r = el.getBoundingClientRect();
      if (r.width < 16 || r.height < 16) continue;
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) continue;
      return true;
    }
    return false;
  }

  // ---- set-of-mark overlay (only while the screenshot is taken) ----------
  function showMarks() {
    hideMarks();
    const root = document.createElement("div");
    root.setAttribute("data-jev-marks", "");
    root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    for (const e of S.last?.elements || []) {
      const b = document.createElement("div");
      b.style.cssText = `position:fixed;left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;outline:1.5px solid rgba(47,91,234,.9);outline-offset:-1px;`;
      const t = document.createElement("span");
      t.textContent = e.id;
      t.style.cssText = "position:absolute;left:0;top:0;background:#2F5BEA;color:#fff;font:600 11px/13px system-ui,sans-serif;padding:0 3px;border-radius:0 0 3px 0;";
      b.appendChild(t);
      root.appendChild(b);
    }
    document.documentElement.appendChild(root);
    S.markRoot = root;
  }
  function hideMarks() {
    S.markRoot?.remove();
    S.markRoot = null;
    document.querySelectorAll("[data-jev-marks]").forEach((n) => n.remove());
  }

  // ---- actions ------------------------------------------------------------
  const isEditable = (el) =>
    !!el && (el.isContentEditable ||
      el.tagName === "TEXTAREA" ||
      (el.tagName === "INPUT" && !["button", "submit", "reset", "checkbox", "radio", "image", "file", "hidden"].includes((el.type || "text").toLowerCase())));

  function editableFrom(el) {
    if (!el) return null;
    if (isEditable(el)) return el;
    const inner = el.querySelector?.("input:not([type=hidden]),textarea,[contenteditable=''],[contenteditable=true]");
    if (isEditable(inner)) return inner;
    const lbl = el.closest?.("label");
    if (lbl?.control && isEditable(lbl.control)) return lbl.control;
    return null;
  }

  async function bringIntoView(el) {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await sleep(150);
    }
  }

  function clickEl(el, point) {
    const r = el.getBoundingClientRect();
    const x = point?.x ?? r.left + r.width / 2;
    const y = point?.y ?? r.top + r.height / 2;
    const m = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window, button: 0 };
    const p = { ...m, pointerType: "mouse", isPrimary: true, pointerId: 1 };
    el.dispatchEvent(new PointerEvent("pointerover", p));
    el.dispatchEvent(new MouseEvent("mouseover", m));
    el.dispatchEvent(new PointerEvent("pointerdown", p));
    el.dispatchEvent(new MouseEvent("mousedown", m));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", p));
    el.dispatchEvent(new MouseEvent("mouseup", m));
    if (typeof el.click === "function") el.click();
    else el.dispatchEvent(new MouseEvent("click", m));
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
  }

  function typeInto(el, text, clear) {
    el.focus();
    if (el.isContentEditable) {
      if (clear) document.execCommand("selectAll");
      document.execCommand("insertText", false, text);
      return;
    }
    setNativeValue(el, clear ? text : el.value + text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    // Autocompletes (PrimeNG, jQuery UI, ...) often search on keyup rather than input.
    const last = text.slice(-1);
    if (last) {
      const k = { key: last, bubbles: true, cancelable: true, composed: true };
      el.dispatchEvent(new KeyboardEvent("keydown", k));
      el.dispatchEvent(new KeyboardEvent("keyup", k));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  const KEYCODES = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32, " ": 32 };

  /** @returns {boolean} true if the page did not cancel keydown */
  function pressKey(el, key) {
    const k = key === "Space" ? " " : key;
    const init = { key: k, code: key === " " ? "Space" : key, keyCode: KEYCODES[key] || 0, which: KEYCODES[key] || 0, bubbles: true, cancelable: true, composed: true };
    const notPrevented = el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (k === "Enter" || k.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
    if (k === "Tab" && notPrevented) focusNext(el);
    return notPrevented;
  }

  function focusNext(from) {
    const all = [...document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])")]
      .filter((e) => !e.disabled && e.offsetParent !== null);
    const i = all.indexOf(from);
    all[(i + 1) % all.length]?.focus();
  }

  function submitFrom(el) {
    const notPrevented = pressKey(el, "Enter");
    if (notPrevented && el.form) {
      if (el.form.requestSubmit) el.form.requestSubmit();
      else el.form.submit();
    }
  }

  function scrollableAncestor(el) {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll)/.test(cs.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  }

  function selectOption(s, text) {
    const want = String(text || "").trim().toLowerCase();
    const opts = [...s.options];
    const opt = opts.find((o) => o.text.trim().toLowerCase() === want)
      || opts.find((o) => o.value.toLowerCase() === want)
      || opts.find((o) => o.text.toLowerCase().includes(want));
    if (!opt) throw new Error(`No option matching "${text}". Options: ${opts.map((o) => o.text.trim()).slice(0, 15).join(", ")}`);
    s.value = opt.value;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    s.dispatchEvent(new Event("change", { bubbles: true }));
    return opt.text.trim();
  }

  // ---- searchable dropdowns (react-select and co.) -------------------------------
  // Select-style dropdowns with a search box (react-select). Plain autocompletes (react-autosuggest) are typed into instead.
  const isSearchable = (el) => el?.tagName === "INPUT" && !!el.closest("[class*='__control'], [class*='-control']") && !el.closest("[class*='autosuggest' i]");
  const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  /** Options of this dropdown's open menu only (react-select renders it next to the control, or in a portal). */
  const menuOptions = (ctl) => {
    const box = ctl.closest("[class*='container']") || ctl.parentElement;
    let opts = [...box.querySelectorAll("[class*='__option'], [class*='-option'], [role=option]")].filter(shown);
    if (!opts.length) opts = [...document.querySelectorAll("[class*='__menu'] [class*='option'], [class*='-menu'] [class*='option'], [role=listbox] [role=option]")].filter(shown);
    return opts;
  };

  /** Best option for `want`: exact, numeric-equal (05 = 5), month (10 / October = Oct), "+91" = "India(91)", then contains. */
  function matchOption(opts, want) {
    const w = String(want).trim().toLowerCase().replace(/^\+/, "");
    const t = (o) => clean(o.innerText).toLowerCase();
    const num = (x) => (/^\d+$/.test(x) ? Number(x) : NaN);
    let m = opts.find((o) => t(o) === w)
      || opts.find((o) => !isNaN(num(w)) && num(t(o)) === num(w))
      || opts.find((o) => t(o).includes(`(${w})`) || t(o).includes(`+${w}`));
    if (!m) {
      const mi = !isNaN(num(w)) && num(w) >= 1 && num(w) <= 12 ? num(w) - 1 : MON.indexOf(w.slice(0, 3));
      if (mi >= 0 && opts.some((o) => MON.includes(t(o).slice(0, 3)))) m = opts.find((o) => t(o).startsWith(MON[mi]));
    }
    return m || opts.find((o) => t(o).startsWith(w)) || opts.find((o) => t(o).includes(w));
  }

  /** Opens the dropdown that owns `input`, types to filter, clicks the right option, and checks it stuck. */
  async function pickSearchable(input, want) {
    const ctl = input.closest("[class*='__control'], [class*='-control'], [class*='container']") || input.parentElement;
    const shownText = () => clean(ctl.innerText);
    if (shownText().toLowerCase() === String(want).toLowerCase()) return shownText();
    await bringIntoView(ctl);
    const r = ctl.getBoundingClientRect();
    const m = { bubbles: true, cancelable: true, composed: true, clientX: r.left + 10, clientY: r.top + r.height / 2, view: window, button: 0 };
    ctl.dispatchEvent(new MouseEvent("mousedown", m));
    ctl.dispatchEvent(new MouseEvent("mouseup", m));
    input.focus();
    await sleep(120);
    // Filter with the month's short name when the list is months, else the value itself.
    let opt = matchOption(menuOptions(ctl), want);
    if (!opt) {
      let q = String(want).trim().replace(/^\+/, "");
      const mi = /^\d{1,2}$/.test(q) && Number(q) <= 12 ? Number(q) - 1 : MON.indexOf(q.slice(0, 3).toLowerCase());
      const months = menuOptions(ctl).some((o) => MON.includes(clean(o.innerText).toLowerCase().slice(0, 3)));
      if (months && mi >= 0) q = MON[mi];
      setNativeValue(input, q);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      opt = await waitFor(() => matchOption(menuOptions(ctl), want), 2500);
    }
    if (!opt) {
      const seen = menuOptions(ctl).slice(0, 8).map((o) => clean(o.innerText, 20)).join(", ");
      pressKey(input, "Escape");
      throw new Error(`no option "${want}"${seen ? ` (options: ${seen})` : ""}`);
    }
    const label = clean(opt.innerText, 30);
    const orr = opt.getBoundingClientRect();
    const om = { ...m, clientX: orr.left + 5, clientY: orr.top + orr.height / 2 };
    opt.dispatchEvent(new MouseEvent("mousedown", om));
    opt.dispatchEvent(new MouseEvent("mouseup", om));
    opt.dispatchEvent(new MouseEvent("click", om));
    await sleep(150);
    if (!shownText().toLowerCase().includes(label.toLowerCase())) throw new Error(`picked "${label}" but the box shows "${shownText()}"`);
    return label;
  }

  /** Fills several fields in one go: text fields get typed, native dropdowns selected, checkboxes/radios clicked. */
  async function fill(fields) {
    const done = [], failed = [];
    for (const f of fields) {
      const el = byId(f.id);
      try {
        if (!el) throw new Error("no longer on the page");
        await bringIntoView(el);
        const sel = el.tagName === "SELECT" ? el : el.querySelector?.("select");
        if (isSearchable(el)) done.push(`${labelOf(el) || f.id} = "${await pickSearchable(el, f.value)}"`);
        else if (sel) done.push(`${sel.getAttribute("aria-label") || sel.getAttribute("formcontrolname") || sel.name || f.id} = "${selectOption(sel, f.value)}"`);
        else if (el.type === "checkbox" || el.type === "radio" || /^(checkbox|radio)$/.test(el.getAttribute("role") || "")) {
          const on = !/^(false|no|off|uncheck)$/i.test(String(f.value ?? ""));
          const checked = el.checked ?? el.getAttribute("aria-checked") === "true";
          if (on !== checked) clickEl(hitTarget(el));
          done.push(`${labelOf(el) || f.id} ${on ? "checked" : "unchecked"}`);
        } else if (!editableFrom(el) && /^(check|uncheck|click|yes|tick|true)$/i.test(String(f.value ?? "").trim())) {
          // A styled "checkbox" that is really clickable text (MakeMyTrip's billing confirmation).
          clickEl(el);
          done.push(`${labelOf(el) || f.id} clicked`);
        } else if (!editableFrom(el) || el.closest(".p-dropdown, [role=combobox]:not(input)")) {
          // Custom dropdown (PrimeNG and co.): open it, click the option.
          const dd = el.closest(".p-dropdown, .ui-dropdown, [role=combobox]") || el;
          const want = String(f.value ?? "").trim().toLowerCase();
          if (clean(dd.innerText).toLowerCase() === want) { done.push(`${f.id} = "${f.value}"`); continue; }
          clickEl(dd.querySelector(".p-dropdown-trigger, .ui-dropdown-trigger") || dd);
          const opt = await waitFor(() => {
            const os = options();
            return os.find((o) => clean(o.innerText).toLowerCase() === want) || os.find((o) => clean(o.innerText).toLowerCase().includes(want));
          }, 2500);
          if (!opt) { pressKey(dd, "Escape"); throw new Error(`no option "${f.value}"`); }
          const label = clean(opt.innerText, 40);
          clickEl(opt);
          await sleep(120);
          done.push(`${f.id} = "${label}"`);
        } else {
          const t = editableFrom(el);
          if (!t) throw new Error("not a text field or dropdown");
          typeInto(t, String(f.value ?? ""), true);
          t.dispatchEvent(new Event("blur"));
          done.push(`${labelOf(t) || t.placeholder || f.id} = "${clean(f.value, 40)}"`);
        }
      } catch (e) {
        failed.push(`${f.id}: ${e.message}`);
      }
      await sleep(60);
    }
    return { ok: failed.length === 0, detail: `filled ${done.join("; ")}${failed.length ? `. Failed: ${failed.join("; ")}` : ""}` };
  }

  // ---- IRCTC search form (fast path; the planner takes over if anything here fails) ----
  const shown = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };
  async function waitFor(fn, ms = 4000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = fn();
      if (v) return v;
      await sleep(100);
    }
    return null;
  }
  const options = () => [...document.querySelectorAll("li[role=option], [role=listbox] [role=option], .p-autocomplete-item, .p-dropdown-item, .ui-autocomplete-list-item, .ui-dropdown-item, .react-autosuggest__suggestion")].filter(shown);
  const QUOTAS = { GN: "GENERAL", TQ: "TATKAL", PT: "PREMIUM TATKAL", LD: "LADIES", SS: "LOWER BERTH", DP: "DUTY PASS", HP: "PERSON WITH DISABILITY" };

  /** Clears the box and types one key at a time; some autocompletes ignore a pasted value. */
  async function typeLikeAPerson(input, text, click = true) {
    input.focus();
    if (click) clickEl(input);
    setNativeValue(input, "");
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
    await sleep(60);
    for (const ch of text) {
      const k = { key: ch, code: `Key${ch.toUpperCase()}`, bubbles: true, cancelable: true, composed: true };
      input.dispatchEvent(new KeyboardEvent("keydown", k));
      input.dispatchEvent(new KeyboardEvent("keypress", k));
      setNativeValue(input, input.value + ch);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
      input.dispatchEvent(new KeyboardEvent("keyup", k));
      await sleep(click ? 70 : 30);
    }
  }

  async function pickStation(sel, code) {
    const input = document.querySelector(`${sel} input`);
    if (!shown(input)) throw new Error(`${sel} box not found`);
    // Exact station only: "LOKMANYATILAK T - LTT (MUMBAI)". Recent searches look like "A - LTT ➡ B - SC"; skip those.
    const re = new RegExp(`(-\\s*${code}\\b|\\(${code}\\))`, "i");
    const own = () => {
      const list = document.getElementById(input.getAttribute("aria-controls") || "") || input.closest(".p-autocomplete, p-autocomplete")?.querySelector("ul");
      const mine = list ? [...list.querySelectorAll("li")].filter(shown) : [];
      return mine.length ? mine : options();
    };
    let opt = null;
    for (let attempt = 0; attempt < 3 && !opt; attempt++) {
      await typeLikeAPerson(input, code);
      opt = await waitFor(() => own().find((o) => !/[➡→]|\s->\s/.test(o.innerText) && re.test(o.innerText)), 2500);
    }
    if (!opt) throw new Error(`no suggestion for ${code}`);
    const label = clean(opt.innerText, 60);
    clickEl(opt);
    await sleep(150);
    return label;
  }

  async function pickDropdown(sel, match) {
    const dd = document.querySelector(sel);
    if (!shown(dd)) throw new Error(`${sel} dropdown not found`);
    const current = clean(dd.innerText, 60);
    if (match.test(current)) return current;
    clickEl(dd.querySelector(".p-dropdown-trigger, .ui-dropdown-trigger") || dd);
    const opt = await waitFor(() => options().find((o) => match.test(o.innerText)), 3000);
    if (!opt) { document.body.click(); throw new Error(`no option ${match} in ${sel}`); }
    const label = clean(opt.innerText, 60);
    clickEl(opt);
    await sleep(150);
    return label;
  }

  const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

  async function pickDate(ddmmyyyy) {
    const d = document.querySelector("#jDate input");
    if (!shown(d)) throw new Error("date box not found");
    if (d.value === ddmmyyyy) return d.value;
    const [day, month, year] = ddmmyyyy.split("/").map(Number);

    // IRCTC's calendar usually ignores typed text, so use the picker.
    clickEl(d);
    const cal = await waitFor(() => [...document.querySelectorAll(".p-datepicker, .ui-datepicker")].find(shown), 2000);
    if (cal) {
      for (let i = 0; i < 14; i++) {
        const title = clean(cal.querySelector(".p-datepicker-title, .ui-datepicker-title")?.innerText).toLowerCase();
        const mi = MONTHS.findIndex((m) => title.includes(m));
        const yi = Number(title.match(/\d{4}/)?.[0]);
        if (mi === month - 1 && yi === year) break;
        const fwd = yi < year || (yi === year && mi < month - 1);
        const nav = cal.querySelector(fwd ? ".p-datepicker-next, .ui-datepicker-next" : ".p-datepicker-prev, .ui-datepicker-prev");
        if (!nav) break;
        clickEl(nav);
        await sleep(120);
      }
      const cell = [...cal.querySelectorAll("td:not(.p-datepicker-other-month):not(.ui-datepicker-other-month) span, td:not(.p-datepicker-other-month):not(.ui-datepicker-other-month) a")]
        .find((x) => clean(x.innerText) === String(day) && !/disabled/.test(x.className));
      if (cell) { clickEl(cell); await sleep(200); }
    }
    if (d.value !== ddmmyyyy) {
      // Last try: typed text, for calendars that do accept it.
      d.focus();
      typeInto(d, ddmmyyyy, true);
      pressKey(d, "Enter");
      await sleep(150);
    }
    if ([...document.querySelectorAll(".p-datepicker, .ui-datepicker")].some(shown)) { pressKey(d, "Escape"); document.body.click(); }
    if (d.value !== ddmmyyyy) throw new Error(`date stayed ${d.value || "empty"}; wanted ${ddmmyyyy}`);
    return d.value;
  }

  // ---- IRCTC train-list: class availability inside one train card ----------
  const CLASS_RE = /\((SL|3A|2A|1A|3E|CC|EC|2S|FC|EA|EV|VS)\)/;
  const STATUS_RE = /AVAILABLE|WL\b|RAC|REGRET|NOT AVAILABLE|DEPARTED|CHART PREPARED|TQWL|GNWL|RLWL|PQWL|₹/i;

  function trainCard(from) {
    for (let p = from; p && p !== document.body; p = p.parentElement) {
      const t = p.innerText || "";
      if (/\(\d{5}\)/.test(t) && (t.match(/\(\d{5}\)/g) || []).length === 1 && /Book Now/i.test(t)) return p;
    }
    return null;
  }

  function classBoxes(card) {
    return [...card.querySelectorAll("div, td, li")].filter((x) => {
      if (!shown(x) || !CLASS_RE.test((x.innerText || "").split("\n")[0])) return false;
      if (getComputedStyle(x).cursor !== "pointer") return false;
      const p = x.parentElement;
      return !(p && getComputedStyle(p).cursor === "pointer" && CLASS_RE.test((p.innerText || "").split("\n")[0]));
    });
  }

  function boxStatus(box) {
    const lines = clean(box.innerText.replace(/\n+/g, " | "), 200).split(" | ").slice(1)
      .filter((l) => !/^(Refresh|Get Availability)$/i.test(l.trim()));
    const st = lines.join(" ").trim();
    return STATUS_RE.test(st) ? st : "";
  }

  /** Reads (and with check:true, fetches) every class's status in the train card holding element `id`. */
  async function irctcClasses(id, check) {
    const el = byId(id);
    const card = el && trainCard(el);
    if (!card) return null;
    const train = clean((card.innerText.match(/^[^\n]*\(\d{5}\)/m) || [""])[0], 60);
    const out = [];
    for (const box of classBoxes(card)) {
      const code = box.innerText.match(CLASS_RE)[1];
      let status = boxStatus(box);
      if (!status && check) {
        clickEl(box);
        status = await waitFor(() => boxStatus(box), 6000) || "no answer from IRCTC";
      }
      out.push({ code, name: clean(box.innerText.split("\n")[0], 30), status });
    }
    return { train, classes: out };
  }

  async function irctcSearch(p) {
    const done = [];
    try {
      // Startup alert ("OK") covers the form.
      for (const b of document.querySelectorAll(".p-dialog button, [role=dialog] button, .ui-dialog button"))
        if (shown(b) && /^ok$/i.test(clean(b.innerText))) { clickEl(b); await sleep(200); }

      if (p.from) done.push(`From ${await pickStation("#origin", p.from)}`);
      if (p.to) done.push(`To ${await pickStation("#destination", p.to)}`);
      if (p.date) done.push(`date ${await pickDate(p.date)}`);
      if (p.class) done.push(`class ${await pickDropdown("#journeyClass", new RegExp(`\\(${p.class}\\)`, "i"))}`);
      if (p.quota && p.quota.toUpperCase() !== "GN") {
        const q = QUOTAS[p.quota.toUpperCase()] || p.quota;
        done.push(`quota ${await pickDropdown("#journeyQuota", new RegExp(q, "i"))}`);
      }
      const form = document.querySelector("#origin")?.closest("form");
      const btn = [...document.querySelectorAll("button.search_btn, button.train_Search")].find(shown)
        || [...(form || document).querySelectorAll("button, input[type=submit]")].find((b) => shown(b) && /\bsearch\b/i.test(clean(b.innerText || b.value)) && !/modify/i.test(b.innerText))
        || [...(form || document).querySelectorAll("button[type=submit]")].find(shown);
      if (btn) clickEl(btn);
      else if (form) form.requestSubmit();
      else throw new Error("Search button not found");
      done.push("clicked Search");
      return { ok: true, detail: done.join(", ") };
    } catch (e) {
      return { ok: false, detail: `${done.length ? done.join(", ") + ". " : ""}Stopped: ${e.message}. Finish the search form by hand.` };
    }
  }

  async function act(a) {
    let el = a.id ? byId(a.id) : null;
    if (!el && a.point) el = document.elementFromPoint(a.point.x, a.point.y);

    switch (a.type) {
      case "click": {
        if (!el) throw new Error("The target is no longer on the page.");
        await bringIntoView(hitTarget(el));
        const desc = describe(el);
        clickEl(hitTarget(el), a.id ? null : a.point);
        return { ok: true, detail: `clicked ${desc}` };
      }
      case "hover": {
        if (!el) throw new Error("The target is no longer on the page.");
        await bringIntoView(el);
        const m = { bubbles: true, view: window };
        el.dispatchEvent(new PointerEvent("pointerover", m));
        el.dispatchEvent(new MouseEvent("mouseover", m));
        el.dispatchEvent(new MouseEvent("mouseenter", { view: window }));
        return { ok: true, detail: `hovered ${describe(el)}` };
      }
      case "type": {
        let f = editableFrom(el) || (isEditable(document.activeElement) ? document.activeElement : null);
        if (!f) throw new Error("No text field at the target.");
        if (isSearchable(f)) return { ok: true, detail: `picked "${await pickSearchable(f, a.text ?? "")}" in ${labelOf(f) || "the dropdown"}` };
        if (f.readOnly || f.disabled) {
          // A read-only box that opens the real search input (MakeMyTrip, Goibibo, ...): open it and use that.
          clickEl(f);
          const real = await waitFor(() => {
            const ae = document.activeElement;
            if (ae && ae !== f && isEditable(ae) && !ae.readOnly) return ae;
            return [...document.querySelectorAll("input:not([type=hidden]):not([readonly]), textarea")]
              .find((x) => x !== f && isEditable(x) && visibleRect(x) && !x.value && x.closest("[role=combobox], [role=dialog], [class*=popup], [class*=autosuggest], [class*=dropdown], [class*=Popup]"));
          }, 1500);
          if (!real) throw new Error("That field is read-only and clicking it didn't open a text box. Click the box first, then type into the input that appears.");
          f = real;
        }
        await bringIntoView(f);
        const text = a.text ?? "";
        if (f.tagName === "INPUT" && text.length <= 40 && f.type !== "password" && a.clear !== false) await typeLikeAPerson(f, text, false);
        else typeInto(f, text, a.clear !== false);
        if (a.submit) submitFrom(f);
        const picks = options().length;
        return { ok: true, detail: `typed "${clean(text, 60)}" into ${describe(f)}${a.submit ? " and pressed Enter" : ""}${picks ? `; ${picks} suggestions are showing, click the right one` : ""}` };
      }
      case "select": {
        const s = el?.tagName === "SELECT" ? el : el?.querySelector?.("select");
        if (s) return { ok: true, detail: `selected "${selectOption(s, a.text)}"` };
        // Custom dropdowns: a searchable one (react-select) or a click-to-open list.
        const inner = isSearchable(el) ? el : el?.querySelector?.("input");
        if (inner && isSearchable(inner)) return { ok: true, detail: `picked "${await pickSearchable(inner, a.text ?? "")}" in ${labelOf(inner) || "the dropdown"}` };
        if (!el) throw new Error("The target is no longer on the page.");
        const r = await fill([{ id: idFor(el), value: a.text ?? "" }]);
        if (!r.ok) throw new Error(r.detail);
        return r;
      }
      case "scroll": {
        const dir = a.direction === "up" ? -1 : 1;
        const sc = el ? scrollableAncestor(el) : null;
        const dy = dir * Math.round((sc ? sc.clientHeight : innerHeight) * 0.8);
        (sc || window).scrollBy({ top: dy, behavior: "instant" });
        await sleep(300);
        return { ok: true, detail: `scrolled ${dir < 0 ? "up" : "down"}${sc ? " inside a panel" : ""}` };
      }
      case "press_key": {
        const target = document.activeElement || document.body;
        const key = a.key || "Enter";
        const notPrevented = pressKey(target, key);
        if (key === "Enter" && notPrevented && target.form) target.form.requestSubmit?.();
        return { ok: true, detail: `pressed ${key}` };
      }
      default:
        throw new Error(`Unknown action ${a.type}`);
    }
  }

  // ---- helpers for real (debugger) input: the page part --------------------
  const center = (el) => { const r = hitTarget(el).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  async function locate(a) {
    let el = a.id ? byId(a.id) : null;
    if (!el && a.point) el = document.elementFromPoint(a.point.x, a.point.y);
    if (!el) return { ok: false, detail: "The target is no longer on the page." };
    await bringIntoView(el);
    return { ok: true, ...(a.id ? center(el) : a.point), desc: describe(el) };
  }

  function clearField(f) {
    if (f.isContentEditable) { f.focus(); document.execCommand("selectAll"); document.execCommand("delete"); return; }
    setNativeValue(f, "");
    f.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }

  /** Finds the field to type into. A read-only box is reported back so it can be clicked for real. */
  async function prepType(a) {
    const el = a.id ? byId(a.id) : (a.point ? document.elementFromPoint(a.point.x, a.point.y) : null);
    const f = editableFrom(el) || (isEditable(document.activeElement) ? document.activeElement : null);
    if (!f) return { ok: false, detail: "No text field at the target." };
    await bringIntoView(f);
    if (isSearchable(f)) return { ok: true, searchable: true, id: idFor(f) };
    if (f.readOnly || f.disabled) return { ok: true, readonly: true, id: idFor(f), ...center(f) };
    return { ok: true, id: idFor(f), ...center(f) };
  }

  /** After a read-only box was clicked: the input that opened. */
  async function openedInput(a) {
    const old = a.id ? byId(a.id) : null;
    const real = await waitFor(() => {
      const ae = document.activeElement;
      if (ae && ae !== old && isEditable(ae) && !ae.readOnly) return ae;
      return [...document.querySelectorAll("input:not([type=hidden]):not([readonly]), textarea")]
        .find((x) => x !== old && isEditable(x) && visibleRect(x) && !x.value);
    }, 2000);
    if (!real) return { ok: false, detail: "Clicking the read-only box didn't open a text box." };
    return { ok: true, id: idFor(real), ...center(real) };
  }

  /** Is this field the focused element (after a real click)? Re-aims if the page jumped. */
  async function focusCheck(id) {
    const f = byId(id);
    if (!f) return { ok: false };
    if (document.activeElement === f) return { ok: true, focused: true };
    await bringIntoView(f);
    return { ok: true, focused: false, ...center(f) };
  }

  function forceFocus(id) {
    const f = byId(id);
    f?.focus();
    return { ok: document.activeElement === f };
  }

  function valueOf(id) {
    const f = byId(id);
    if (!f) return { gone: true };
    if (f.type === "password") return { length: f.value.length };
    return { value: f.isContentEditable ? f.innerText : f.value, searchable: f.getAttribute("aria-autocomplete") === "list" };
  }

  /** Fields for a real-input fill: where each is, and whether it's text or something else. */
  async function fillPlan(fields) {
    return fields.map((f) => {
      const el = byId(f.id);
      if (!el) return { id: f.id, kind: "gone" };
      const sel = el.tagName === "SELECT" ? el : el.querySelector?.("select");
      if (isSearchable(el)) return { id: f.id, kind: "searchable" };
      if (sel) return { id: f.id, kind: "select" };
      if (el.type === "checkbox" || el.type === "radio" || /^(checkbox|radio)$/.test(el.getAttribute("role") || "")) return { id: f.id, kind: "check" };
      const t = editableFrom(el);
      if (t && !t.readOnly) return { id: idFor(t), kind: "text" };
      return { id: f.id, kind: "other" };
    });
  }

  function clearById(id) {
    const f = byId(id);
    if (!f) return { ok: false };
    f.focus();
    if (!f.readOnly) clearField(f);
    return { ok: true };
  }

  function typedInfo(id) {
    const f = byId(id);
    const picks = options().length;
    return { desc: f ? describe(f) : "the field", picks };
  }

  function pointInfo(x, y) {
    let el = document.elementFromPoint(x, y);
    if (!el) return null;
    el = el.closest(SELECTOR) || el;
    return { id: idFor(el), desc: describe(el) };
  }

  // ---- messaging ----------------------------------------------------------
  function listener(msg, _sender, send) {
    try {
      switch (msg.cmd) {
        case "ping": send({ pong: true }); return;
        case "snapshot": send(snapshot()); return;
        case "marks":
          if (msg.show) {
            showMarks();
            requestAnimationFrame(() => requestAnimationFrame(() => send({ ok: true })));
            return true;
          }
          hideMarks(); send({ ok: true }); return;
        case "point": send(pointInfo(msg.x, msg.y)); return;
        case "busy": send(busy()); return;
        case "toasts": send(errorToasts()); return;
        case "dismissToasts": send(dismissToasts()); return;
        case "irctcClasses": irctcClasses(msg.id, !!msg.check).then(send, () => send(null)); return true;
        case "locate": locate(msg).then(send, (e) => send({ ok: false, detail: e.message })); return true;
        case "prepType": prepType(msg).then(send, (e) => send({ ok: false, detail: e.message })); return true;
        case "openedInput": openedInput(msg).then(send, (e) => send({ ok: false, detail: e.message })); return true;
        case "clearField": send(clearById(msg.id)); return;
        case "focusCheck": focusCheck(msg.id).then(send); return true;
        case "forceFocus": send(forceFocus(msg.id)); return;
        case "valueOf": send(valueOf(msg.id)); return;
        case "fillPlan": fillPlan(msg.fields).then(send); return true;
        case "typedInfo": send(typedInfo(msg.id)); return;
        case "loginState": send(loginState(!!msg.focus)); return;
        case "loginInfo": send(loginInfo()); return;
        case "submitLogin":
          submitLogin().then(send, (e) => send({ ok: false, detail: e.message }));
          return true;
        case "act":
          Promise.resolve(act(msg.action)).then(send, (e) => send({ ok: false, detail: e.message }));
          return true;
        case "fill":
          fill(msg.fields).then(send, (e) => send({ ok: false, detail: e.message }));
          return true;
        case "irctcSearch":
          irctcSearch(msg.params).then(send, (e) => send({ ok: false, detail: e.message }));
          return true;
      }
    } catch (e) {
      send({ ok: false, detail: e.message });
    }
  }
  if (window.__jevListener) { try { chrome.runtime.onMessage.removeListener(window.__jevListener); } catch {} }
  window.__jevListener = listener;
  chrome.runtime.onMessage.addListener(listener);
})();

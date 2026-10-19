// Keeps passwords in the goal away from the models. The planner sees {{PASSWORD}}
// and the real value is swapped in only when the text is typed into the page.

const PATTERNS = [
  // "password Secret12@@!!", "pwd: x", "pass = x"
  { name: "PASSWORD", re: /\b(password|passwd|pwd|pass)\b\s*(?:is\s+)?[:=]?\s*("[^"]+"|'[^']+'|\S+)/gi },
  // "pin 1234", "upi pin: 1234"
  { name: "PIN", re: /\b(pin|mpin|upi pin)\b\s*(?:is\s+)?[:=]?\s*(\d{4,6})\b/gi }
];

/**
 * @param {string} goal
 * @returns {{goal:string, secrets:Record<string,string>}} goal with secrets replaced by {{NAME}}
 */
export function redactGoal(goal) {
  const secrets = {};
  let out = goal;
  for (const { name, re } of PATTERNS) {
    out = out.replace(re, (_m, word, value) => {
      let v = value.replace(/^(["'])(.*)\1$/, "$2");
      // A trailing comma or full stop is punctuation, not part of the password.
      v = v.replace(/[,;.]$/, "");
      if (!v) return _m;
      const key = secrets[name] && secrets[name] !== v ? `${name}_${Object.keys(secrets).length + 1}` : name;
      secrets[key] = v;
      return `${word} {{${key}}}`;
    });
  }
  return { goal: out, secrets };
}

/** Replaces {{NAME}} placeholders with the real values. */
export function fillSecrets(text, secrets) {
  return String(text ?? "").replace(/\{\{([A-Z_0-9]+)\}\}/g, (m, k) => (k in secrets ? secrets[k] : m));
}

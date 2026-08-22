/**
 * Discord text formatting for model output.
 *
 * Discord renders CommonMark-ish markdown but has no math support, so any
 * LaTeX a model emits ($...$) would show as raw source. sanitizeForDiscord
 * rewrites the common cases to plain Unicode text before anything is
 * posted or recorded (the model is not always compliant); anything
 * unmappable is kept as close to the original as possible.
 */

/** LaTeX command names mapped to Unicode (no backslash, case-sensitive). */
const LATEX_UNICODE: Record<string, string> = {
  // Greek letters (lowercase, then uppercase).
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "ϑ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  varrho: "ϱ",
  sigma: "σ",
  varsigma: "ς",
  tau: "τ",
  upsilon: "υ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Upsilon: "Υ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  // Arrows.
  uparrow: "↑",
  downarrow: "↓",
  leftarrow: "←",
  rightarrow: "→",
  leftrightarrow: "↔",
  Leftarrow: "⟵",
  Rightarrow: "⟶",
  Leftrightarrow: "⟺",
  to: "→",
  // Operators.
  pm: "±",
  mp: "∓",
  times: "×",
  div: "÷",
  cdot: "·",
  bullet: "•",
  circ: "∘",
  // Relations.
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  simeq: "≃",
  propto: "∝",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  ll: "≪",
  gg: "≫",
  // Set / logic.
  in: "∈",
  notin: "∉",
  subset: "⊂",
  supset: "⊃",
  subseteq: "⊆",
  supseteq: "⊇",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  varnothing: "∅",
  forall: "∀",
  exists: "∃",
  neg: "¬",
  lnot: "¬",
  land: "∧",
  lor: "∨",
  // Misc.
  infty: "∞",
  partial: "∂",
  nabla: "∇",
  sum: "Σ",
  prod: "∏",
  int: "∫",
  angle: "∠",
  degree: "°",
  prime: "′",
  hbar: "ℏ",
  ell: "ℓ",
  Re: "ℜ",
  Im: "ℑ",
  aleph: "ℵ",
  dots: "…",
  cdots: "⋯",
  ldots: "…",
  vdots: "⋮",
  ddots: "⋱",
};

/** Commands dropped entirely (with their braced argument): document noise. */
const LATEX_DROP_RE =
  /\\(?:label|cite[a-z]*|ref|eqref|pageref|tag|textcolor|color|page)\{[^{}]*\}/g;

/** Characters with a Unicode subscript (used for _2, _max, ...). */
const SUBSCRIPT: Record<string, string> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  o: "ₒ",
  x: "ₓ",
  h: "ₕ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  v: "ᵥ",
};

/** Characters with a Unicode superscript (used for ^2, ^+, ...). */
const SUPERSCRIPT: Record<string, string> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  i: "ⁱ",
  n: "ⁿ",
  "'": "ʹ",
};

/** `_{x}` / `^{x}` / `_2` / `^+` -> the mapped Unicode characters. */
function replaceScript(s: string, marker: string, map: Record<string, string>): string {
  const escaped = marker === "^" ? "\\^" : marker;
  const re = new RegExp(`${escaped}(\\{[^{}]*\\}|[0-9a-zA-Z+\\-=])`, "g");
  return s.replace(re, (m, body: string) => {
    const inner = body.startsWith("{") ? body.slice(1, -1) : body;
    if (inner.length === 0) return "";
    const chars = Array.from(inner);
    const mapped = chars.map((ch) => map[ch]);
    // All-or-nothing: when any character has no Unicode mapping, keep the
    // original span (dropping the marker would silently change the text,
    // e.g. a_b -> ab, and a partial mix like xₐb is worse than the source).
    if (mapped.some((u) => u === undefined)) return m;
    return mapped.join("");
  });
}

/** Best-effort conversion of one math body (the text between the $'s). */
function convertMath(inner: string): string {
  let s = inner.replace(/\s+/g, " ").trim();

  // \text{...} & friends: keep the contents (loop for nesting).
  let prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(
      /\\(?:text|textrm|mathrm|mathit|mathbf|operatorname|boldsymbol|ensuremath)\{([^{}]*)\}/g,
      "$1",
    );
  }

  // \frac{a}{b} -> a/b (loop for nesting); \sqrt{x} -> √x or √(x).
  prev = "";
  while (s !== prev) {
    prev = s;
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "$1/$2");
  }
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, (_m, x: string) => (/\s/.test(x) ? `√(${x})` : `√${x}`));

  // Known commands -> Unicode (longest name first so \varphi wins over \phi).
  const names = Object.keys(LATEX_UNICODE).sort((a, b) => b.length - a.length);
  s = s.replace(
    new RegExp(`\\\\(${names.join("|")})(?![a-zA-Z])`, "g"),
    (_m, n: string) => LATEX_UNICODE[n],
  );

  // Document-noise commands: drop command + argument.
  s = s.replace(LATEX_DROP_RE, "");

  // Subscripts / superscripts -> Unicode where the code point exists.
  s = replaceScript(s, "_", SUBSCRIPT);
  s = replaceScript(s, "^", SUPERSCRIPT);

  // Escaped punctuation -> the character itself; literal backslash.
  s = s.replace(/\\\\/g, "\\").replace(/\\([\%_&#\[\]$])/g, "$1");

  // Unknown commands: drop the name, keep a braced argument's text.
  s = s.replace(/\\[a-zA-Z]+(\{[^{}]*\})?/g, (_m, arg?: string) => (arg ? arg.slice(1, -1) : ""));

  // Leftover braces and doubled spaces.
  return s.replace(/[{}]/g, "").replace(/ {2,}/g, " ").trim();
}

/** Is a $...$ region math rather than money ("$5 and $10")? */
const MATHISH_RE = /\\[a-zA-Z]|[_^]/;

/**
 * Rewrite LaTeX math in model output to plain Unicode text for Discord:
 * `$$...$$` display math is always converted; `$...$` inline spans are
 * converted only when their content looks like math (backslash commands,
 * sub/superscripts), so prices like "$5 and $10" are left alone. Anything
 * unmappable is kept as close to the original as possible.
 */
export function sanitizeForDiscord(text: string): string {
  if (!text.includes("$")) return text;
  let s = text.replace(/\$\$([\s\S]+?)\$\$/g, (_m, inner: string) => convertMath(inner));
  s = s.replace(/\$([^\n$]+?)\$/g, (m, inner: string) =>
    MATHISH_RE.test(inner) ? convertMath(inner) : m,
  );
  return s;
}

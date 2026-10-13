import crypto from "node:crypto"

/**
 * Context-aware payload detection.
 *
 * The previous detector was a flat list of regexes applied to every field, and
 * it treated "this string looks odd" the same as "this string is an attack".
 * That produced two failures at once:
 *
 *   - ordinary customer text ("click this link", a multi-line support message,
 *     a JSON body) matched patterns like `\b(?:iframe|svg|link|meta|style|base)\b`
 *     or `\r|\n(?=.*:)`, so the caller rejected the field AND escalated to a
 *     permanent IP ban;
 *   - real attacks nobody was looking for (path traversal, SSRF) were missed.
 *
 * So detection is now split into three things that are no longer conflated:
 *
 *   benign      - perfectly normal text, normalised and allowed
 *   suspicious  - worth recording and scoring, but on its own it may never
 *                 block anybody
 *   attack      - a real exploit shape; the request is rejected and risk is
 *                 recorded, but blocking is still the risk engine's decision
 *                 based on accumulated signals, never this function's.
 *
 * Which rules apply depends on the field's own grammar. A `subject` is one
 * line, so a CR/LF in it is an injection attempt. A support `message` is
 * allowed to be multi-line, so a newline in it is just a newline.
 */

export type SecurityFieldKind =
  | "name"
  | "company"
  | "email"
  | "phone"
  | "subject"
  | "message"
  | "address"
  | "search"
  | "metadata"
  | "id"
  | "url"
  | "path"
  | "header"

export type SecuritySignalTier = "benign" | "suspicious" | "attack"

export type SecuritySignal = {
  type: string
  tier: SecuritySignalTier
  score: number
  evidence: string
}

export type PayloadDetection = {
  /** True only for the `attack` tier. Back-compatible with existing callers. */
  dangerous: boolean
  attackTypes: string[]
  signals: SecuritySignal[]
  /** Accumulated risk contribution. 0 when nothing was found. */
  score: number
  tier: SecuritySignalTier
  reason?: string
  normalized: string
  sample: string
  hash: string
}

const MAX_LENGTH: Record<SecurityFieldKind, number> = {
  name: 80,
  company: 120,
  email: 254,
  phone: 24,
  subject: 160,
  message: 3000,
  address: 180,
  search: 120,
  metadata: 500,
  id: 120,
  url: 2048,
  path: 512,
  header: 256,
}

/** Fields that are legitimately multi-line, so a newline is not an attack. */
const MULTILINE_KINDS = new Set<SecurityFieldKind>(["message", "address"])

/** Fields where an embedded newline is never legitimate (single-line grammar). */
const SINGLE_LINE_KINDS = new Set<SecurityFieldKind>([
  "name",
  "company",
  "email",
  "phone",
  "subject",
  "search",
  "metadata",
  "id",
  "url",
  "path",
  "header",
])

const SAFE_TEXT = /^[\p{L}\p{N}\s.,!?:;/@&+\-'"()[\]{}=<>~$%^*_#|\\]+$/u
const SAFE_SHORT_TEXT = /^[\p{L}\p{N}\s.,&'+\-'"()]+$/u
const SAFE_ID = /^[a-zA-Z0-9_.:\-]+$/
const EMAIL_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}$/i
const PHONE_RE = /^\+?[0-9]{8,15}$/

// Real HTML event handlers. Matching `\bon[a-z]+=` would also match "online=",
// "once=" and other ordinary words, which is exactly the false positive that
// caused this rewrite.
const HTML_EVENT_HANDLERS =
  "error|load|click|dblclick|mouseover|mouseout|mouseenter|mouseleave|mousedown|mouseup|" +
  "focus|focusin|focusout|blur|change|input|submit|reset|keydown|keypress|keyup|" +
  "animationstart|animationend|animationiteration|toggle|transitionend|contextmenu|wheel|scroll"

type Rule = {
  type: string
  pattern: RegExp
  tier: Exclude<SecuritySignalTier, "benign">
  score: number
  /** Restrict to these field kinds; omitted means "all kinds". */
  kinds?: SecurityFieldKind[]
}

const ATTACK_RULES: Rule[] = [
  // --- Cross-site scripting -------------------------------------------------
  {
    type: "xss_script_tag",
    pattern: /<\s*\/?\s*script\b[\s\S]*>/i,
    tier: "attack",
    score: 60,
  },
  {
    type: "xss_event_handler",
    pattern: new RegExp(`\\b(?:on)(?:${HTML_EVENT_HANDLERS})\\s*=`, "i"),
    tier: "attack",
    score: 55,
  },
  {
    type: "xss_script_url",
    pattern: /\b(?:javascript|vbscript)\s*:/i,
    tier: "attack",
    score: 55,
  },
  {
    type: "xss_dangerous_tag",
    // A real tag that can execute or exfiltrate: <iframe src=...>, <svg onload=...>.
    // A bare word like "link" or "base" is not a tag and is never matched here.
    pattern: /<\s*(?:iframe|object|embed|svg|math|base|meta|link|form|applet)\b[^>]*[\s>]/i,
    tier: "attack",
    score: 45,
  },
  {
    type: "xss_tag_with_handler",
    pattern: new RegExp(`<\\s*[a-z][^>]*\\b(?:on)(?:${HTML_EVENT_HANDLERS})\\s*=`, "i"),
    tier: "attack",
    score: 60,
  },

  // --- SQL injection --------------------------------------------------------
  {
    type: "sql_injection_union",
    pattern: /\bunion\b[\s/*]*\bselect\b|\bdrop\s+table\b|\binsert\s+into\b|\bdelete\s+from\b|\btruncate\s+table\b/i,
    tier: "attack",
    score: 60,
  },
  {
    type: "sql_injection_boolean",
    pattern: /(?:'|"|\\|\b(?:and|or))\s*(?:'|"|\\)?\s*\w+\s*(?:'|"|\\)?\s*(?:=|<>|!=|like)\s*(?:'|"|\\)?\s*\w+/i,
    tier: "attack",
    score: 50,
  },
  {
    type: "sql_injection_comment",
    pattern: /(?:--|\/\*|\*\/|;)\s*(?:select|drop|insert|update|delete|alter|create|exec)\b/i,
    tier: "attack",
    score: 50,
  },
  {
    type: "sql_injection_stacked",
    pattern: /;\s*(?:drop|delete|update|insert|alter|truncate|exec)\s/i,
    tier: "attack",
    score: 55,
  },
  {
    type: "sql_injection_sleep",
    pattern: /\b(?:sleep|pg_sleep|waitfor\s+delay|benchmark)\s*\(/i,
    tier: "attack",
    score: 45,
  },

  // --- Command injection ----------------------------------------------------
  {
    type: "command_injection",
    pattern: /(?:;|\||&|\n)\s*(?:cat|curl|wget|nc|bash|sh|rm|mv|cp|chmod|chown|kill|python|perl|node)\s+(?:-\w+\s+)*\/|&&|\|\|/,
    tier: "attack",
    score: 60,
  },
  {
    // `$(curl http://evil)` / `${IFS}`. A JavaScript template literal such as
    // `hello ${name}` must not match, so this only fires when the captured text
    // is itself shell-shaped.
    type: "command_substitution",
    pattern: /\$\(\s*(?:curl|wget|cat|nc|bash|sh|python|perl|node|id|whoami|uname|env|printenv|rm)\b|\$\(\s*`[^`]+`\s*\)|%\s*\{[^}]*\}%|%\s*[a-z]\s*%|(?:^|[;&|\n])\s*\$\{IFS\}/i,
    tier: "attack",
    score: 50,
  },

  // --- Server-side request forgery -----------------------------------------
  {
    type: "ssrf_internal_target",
    pattern: new RegExp(
      "https?://(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|\\[?::1\\]?|10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})",
      "i",
    ),
    tier: "attack",
    score: 45,
    kinds: ["url", "id", "search", "message", "metadata"],
  },
  {
    type: "ssrf_cloud_metadata",
    pattern: /\b169\.254\.169\.254\b|\bmetadata\.google\.internal\b|\/latest\/meta-data\//i,
    tier: "attack",
    score: 60,
  },
  {
    type: "ssrf_protocol_switch",
    pattern: /\b(?:gopher|dict|file|ftp|tftp|netdoc):\/\/(?!\/)/i,
    tier: "attack",
    score: 45,
  },

  // --- Path traversal -------------------------------------------------------
  {
    type: "path_traversal",
    pattern: /(?:\.\.[\/\\]){2,}|\.\.%2f|%2e%2e[\/\\]|[\/\\]\.\.(?:[\/\\]|$)/i,
    tier: "attack",
    score: 50,
  },
  {
    type: "path_traversal_encoded",
    pattern: /(?:%252e%252e|%2e%2e(?:%2f|%5c|[\/\\])|%c0%ae|\.\.%c0%af)/i,
    tier: "attack",
    score: 50,
  },

  // --- Prototype pollution / template injection -----------------------------
  {
    type: "prototype_pollution",
    pattern: /__proto__|constructor\s*\[\s*["']prototype["']\s*\]|\bprototype\s*\.\s*\w+\s*=/i,
    tier: "attack",
    score: 55,
  },
  {
    type: "template_injection",
    pattern: /\$\{\s*[^{}]*\b(?:constructor|__proto__|prototype|process|require|globalThis)\b[^{}]*\}/i,
    tier: "attack",
    score: 50,
  },

  // --- Header injection (single-line fields only) ---------------------------
  {
    type: "header_injection",
    pattern: /\r|\n|\u0085|\u2028|\u2029/,
    tier: "attack",
    score: 45,
    kinds: [...SINGLE_LINE_KINDS],
  },

  // --- Response splitting ---------------------------------------------------
  {
    type: "response_splitting",
    pattern: /%\r?\n|%0d%0a|\r\n(?:content-length|set-cookie|location):/i,
    tier: "attack",
    score: 55,
  },

  // --- Null byte -----------------------------------------------------------
  {
    // A NUL is never legitimate in any of these grammars and is the classic
    // string-truncation trick ("file.txt\0.png"). Other control bytes are
    // treated as transport noise below; this one is not.
    type: "null_byte",
    pattern: /\u0000/,
    tier: "attack",
    score: 55,
  },
]

/**
 * Findings that are worth a score but must never, on their own, block anyone.
 * A customer describing an error, quoting a config file or pasting JSON is
 * exactly who these exist for.
 */
const SUSPICIOUS_RULES: Rule[] = [
  {
    type: "html_ish_markup",
    // Angle brackets that are not a known-dangerous construct. Common in
    // support text ("use <your-ip>"), so it scores but does not attack.
    pattern: /<\s*\/?\s*[a-z][^>]{0,120}>/i,
    tier: "suspicious",
    score: 8,
  },
  {
    type: "encoded_payload",
    pattern: /(?:%3c|%3e|%22|%27|&#x?0*3c;?|&#x?0*3e;?|\\u003c|\\x3c)/i,
    tier: "suspicious",
    score: 12,
  },
  {
    type: "script_keyword_in_prose",
    // Someone quoting JavaScript in a ticket. Real.
    pattern: /\b(?:eval|setTimeout|setInterval|Function|innerHTML|document\.write)\s*[\.(]/i,
    tier: "suspicious",
    score: 8,
  },
  {
    type: "raw_control_character",
    // Control bytes usually mean a truncated or corrupted request body, which
    // is a transport problem, not an attack. Score it, never attack on it.
    pattern: /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u,
    tier: "suspicious",
    score: 5,
  },
]

function decodeHtmlEntities(value: string) {
  return value
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&")
    .replace(/&#(\d+);?/g, (_, code) => {
      const n = Number(code)
      return Number.isFinite(n) ? String.fromCodePoint(n) : _
    })
    .replace(/&#x([0-9a-f]+);?/gi, (_, code) => {
      const n = Number.parseInt(code, 16)
      return Number.isFinite(n) ? String.fromCodePoint(n) : _
    })
}

function decodeUnicodeEscapes(value: string) {
  // decodeURIComponent understands %XX but not \uXXXX, so a payload spelled
  // with unicode escapes would otherwise sail past the scan.
  return value.replace(/\\u([0-9a-f]{4})/gi, (_, hex) => {
    const code = Number.parseInt(hex, 16)
    return Number.isFinite(code) ? String.fromCharCode(code) : _
  })
}

/**
 * Normalisation deliberately does NOT strip characters that carry meaning.
 * Full-width or otherwise homoglyph forms are folded to their ASCII equivalent
 * so that `<script>` spelled with compatibility characters is still caught.
 */
export function normalizeSecurityText(value: unknown) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\r\n?/g, "\n")
    .trim()
}

/** A separate, lossy view used only for scanning - removes control bytes so a
 *  corrupted transport cannot masquerade as a payload. */
function stripTransportNoise(value: string) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "")
}

export function payloadHash(value: unknown) {
  return crypto.createHash("sha256").update(String(value ?? "")).digest("hex")
}

/**
 * Ceiling on how much risk a SINGLE request may contribute.
 *
 * This is the structural guarantee behind "one suspicious request never
 * blocks": even a payload stacking every attack class cannot reach the
 * temporary-block threshold on its own, because only the second and subsequent
 * requests accumulate. The full detection score is still recorded in the log;
 * this cap applies only to what feeds the blocking decision.
 */
export const MAX_SINGLE_REQUEST_RISK = 120

/** Score a detection contributes to the risk ledger, capped per request. */
export function riskContributionFor(detection: PayloadDetection): number {
  if (!detection.dangerous) return Math.min(MAX_SINGLE_REQUEST_RISK, detection.score)
  return Math.min(MAX_SINGLE_REQUEST_RISK, detection.score)
}

function evidenceFor(value: string, match: RegExpExecArray | null) {
  if (!match) return ""
  const index = match.index ?? 0
  const start = Math.max(0, index - 12)
  return value.slice(start, index + (match[0].length || 0) + 12).slice(0, 120)
}

function scanRules(value: string, rules: Rule[], kind: SecurityFieldKind): SecuritySignal[] {
  const signals: SecuritySignal[] = []
  for (const rule of rules) {
    if (rule.kinds && !rule.kinds.includes(kind)) continue
    const match = rule.pattern.exec(value)
    if (!match) continue
    signals.push({
      type: rule.type,
      tier: rule.tier,
      score: rule.score,
      evidence: evidenceFor(value, match),
    })
  }
  return signals
}

function tierOf(signals: SecuritySignal[]): SecuritySignalTier {
  if (signals.some((signal) => signal.tier === "attack")) return "attack"
  if (signals.length) return "suspicious"
  return "benign"
}

/**
 * `kind` makes detection context aware. Callers that do not know the grammar
 * of their input should pass a permissive kind (`message`) rather than a
 * strict one, so ordinary text is never escalated.
 */
export function detectPayload(value: unknown, kind: SecurityFieldKind = "message"): PayloadDetection {
  const raw = String(value ?? "")
  const normalized = normalizeSecurityText(raw)

  // Scan the decoded forms too, so encoded payloads are caught, but run the
  // raw form through noise-stripping first so a corrupted request body is not
  // mistaken for an attack.
  const decoded = decodeUnicodeEscapes(decodeHtmlEntities(normalized))
  const decodedUri = (() => {
    try {
      return decodeUnicodeEscapes(decodeURIComponent(decoded))
    } catch {
      return decoded
    }
  })()
  const scanForms = [normalized, decoded, decodedUri, stripTransportNoise(raw)]
    .filter(Boolean)

  const seen = new Set<string>()
  const signals: SecuritySignal[] = []
  for (const form of scanForms) {
    for (const rule of [...ATTACK_RULES, ...SUSPICIOUS_RULES]) {
      const match = rule.pattern.exec(form)
      if (!match) continue
      const dedupeKey = `${rule.type}`
      if (seen.has(dedupeKey)) continue
      seen.add(dedupeKey)
      signals.push({
        type: rule.type,
        tier: rule.tier,
        score: rule.score,
        evidence: evidenceFor(form, match),
      })
    }
  }

  // A newline inside a multi-line field is not header injection; if the field
  // genuinely allows newlines, drop a CRLF-derived finding so it cannot push
  // an ordinary paragraph over the attack line.
  const effectiveSignals = MULTILINE_KINDS.has(kind)
    ? signals.filter((signal) => signal.type !== "header_injection")
    : signals

  const tier = tierOf(effectiveSignals)
  const attackTypes = effectiveSignals.map((signal) => signal.type)
  const score = effectiveSignals.reduce((sum, signal) => sum + signal.score, 0)

  return {
    dangerous: tier === "attack",
    attackTypes,
    signals: effectiveSignals,
    score,
    tier,
    reason: effectiveSignals[0]?.type,
    normalized,
    sample: normalized.slice(0, 500),
    hash: payloadHash(normalized),
  }
}

function allowedForKind(kind: SecurityFieldKind, value: string) {
  if (!value) return true
  if (kind === "email") return EMAIL_RE.test(value)
  if (kind === "phone") return PHONE_RE.test(value)
  if (kind === "id") return SAFE_ID.test(value)
  if (kind === "url") return /^(?:https?:\/\/|\/)[^\s]*$/i.test(value)
  if (kind === "path") return !value.includes("\n")
  if (kind === "name") return /^[\p{L}\p{N}\s]+$/u.test(value)
  if (kind === "company") return SAFE_SHORT_TEXT.test(value)
  if (kind === "subject" || kind === "message" || kind === "address" || kind === "search" || kind === "metadata" || kind === "header") {
    // `'` `"` `(` `)` are ordinary punctuation in support text; rejecting them
    // was another source of customer-facing false positives.
    return SAFE_TEXT.test(value)
  }
  return false
}

export type SecurityFieldResult =
  | { ok: true; value: string; detection: PayloadDetection }
  | { ok: false; value: string; error: string; detection: PayloadDetection }

/**
 * Validates one field for one grammar.
 *
 * `ok: false` means "this value is not acceptable" - it does NOT mean the
 * caller is an attacker. Escalation is a separate decision made by the risk
 * engine from accumulated signals.
 */
export function validateSecurityField(value: unknown, kind: SecurityFieldKind, label: string = kind): SecurityFieldResult {
  const normalized = normalizeSecurityText(value)
  const detection = detectPayload(normalized, kind)

  if (normalized.length > MAX_LENGTH[kind]) {
    return { ok: false, value: normalized, error: `${label} is too long.`, detection }
  }

  if (!allowedForKind(kind, normalized)) {
    return {
      ok: false,
      value: normalized,
      error: `${label} contains unsupported characters.`,
      // Reported as a finding, not as `dangerous`: this is a formatting
      // problem, and treating it as an attack is what banned customers.
      detection: { ...detection, tier: "suspicious", dangerous: false },
    }
  }

  if (detection.dangerous) {
    return { ok: false, value: normalized, error: `${label} contains unsafe content.`, detection }
  }

  return { ok: true, value: normalized, detection }
}

export function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function escapeSerializable<T>(value: T): T {
  if (typeof value === "string") return escapeHtml(value) as T
  if (Array.isArray(value)) return value.map((item) => escapeSerializable(item)) as T
  if (value instanceof Date) return value as T
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, escapeSerializable(entry)])) as T
  }
  return value
}
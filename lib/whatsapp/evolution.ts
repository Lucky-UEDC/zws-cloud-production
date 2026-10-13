import { getRuntimeIntegrationConfig, updateRuntimeIntegrationConfig } from "@/lib/integration-config"
import { prisma } from "@/lib/db"
import { maskWhatsAppPhone, normalizeWhatsAppNumber } from "@/lib/whatsapp/format"
import {
  connectionStateFromInstance,
  connectionStatusFromState,
  connectedNumberFromInstance,
  createEvolutionClient,
  EVOLUTION_WEBHOOK_EVENTS,
  findEvolutionInstance,
  isEvolutionApiError,
  normalizeEvolutionUrl,
  PROBE_EVOLUTION_TIMEOUT_MS,
  sendIdentifierFromInstance,
  webhookEventsFromEvolution,
  webhookUrlFromEvolution,
} from "@/lib/whatsapp/evolution-client"

export { normalizeEvolutionUrl }

export type EvolutionSettings = {
  provider: "evolution"
  serverUrl: string
  instanceId: string
  instanceName?: string
  instanceToken: string
  apiKey: string
  webhookUrl: string
  webhookSecret?: string
  testRecipient: string
  connectedNumber: string
  enabled: boolean
  failsafe: {
    mode: "none" | "log_only" | "mark_failed" | "notify_admin"
    notifyAdminEmail: string
  }
}

export const WHATSAPP_FAILSAFE_MODES = ["none", "log_only", "mark_failed", "notify_admin"] as const
export type WhatsAppFailsafeMode = (typeof WHATSAPP_FAILSAFE_MODES)[number]

export function normalizeFailsafeMode(mode: unknown): WhatsAppFailsafeMode {
  return WHATSAPP_FAILSAFE_MODES.includes(mode as WhatsAppFailsafeMode) ? (mode as WhatsAppFailsafeMode) : "none"
}

export type EvolutionPublicSettings = Omit<EvolutionSettings, "apiKey" | "instanceToken"> & {
  apiKeyConfigured: boolean
  instanceTokenConfigured: boolean
}

export type EvolutionConnectionCheck = {
  key:
    | "api_reachable"
    | "api_key_valid"
    | "instance_exists"
    | "instance_connected"
    | "send_endpoint_valid"
    | "real_send_accepted"
    | "webhook_reachable"
    | "webhook_configured"
  label: string
  ok: boolean
  message: string
}

export type EvolutionConnectionResult = {
  ok: boolean
  status: "PASS" | "FAIL"
  provider: "evolution"
  apiValid: boolean
  instanceFound: boolean
  connected: boolean
  webhookReachable: boolean
  webhookConfigured: boolean
  instanceId: string
  connectionState: string
  connectedNumber: string
  sendInstance: string
  apiVersion?: string
  checks: EvolutionConnectionCheck[]
  instance?: unknown
  instances?: unknown
  webhook?: unknown
}

export const DEFAULT_EVOLUTION_TEST_RECIPIENT = "+919348487611"
const LEGACY_EVOLUTION_KEYS = [`instance${"Name"}`, `webhook${"Secret"}`]

function text(value: unknown) {
  return String(value || "").trim()
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function check(key: EvolutionConnectionCheck["key"], label: string, ok: boolean, message: string): EvolutionConnectionCheck {
  return { key, label, ok, message }
}

function friendlyError(error: unknown) {
  if (isEvolutionApiError(error)) return error.friendlyMessage
  return error instanceof Error ? error.message : String(error || "Evolution API request failed")
}

export function evolutionInstanceIdentifier(settings: Pick<EvolutionSettings, "instanceId">) {
  return text(settings.instanceId)
}

export async function getEvolutionSettings(): Promise<EvolutionSettings> {
  const config = await getRuntimeIntegrationConfig({ decrypted: true, masked: false }).catch(() => ({} as any))
  const whatsappApi = object((config as any).whatsappApi)
  const instanceId = text(whatsappApi.instanceId || process.env.EVOLUTION_INSTANCE)
  const instanceToken = text(whatsappApi.instanceToken || process.env.EVOLUTION_INSTANCE_TOKEN)
  const configured = Boolean(whatsappApi.serverUrl || whatsappApi.url || process.env.EVOLUTION_API_URL) &&
    Boolean(whatsappApi.apiKey || process.env.EVOLUTION_API_KEY) &&
    Boolean(instanceId)
  const failsafeRaw = object(whatsappApi.failsafe)
  const failsafeMode = normalizeFailsafeMode(text(failsafeRaw.mode))
  return {
    provider: "evolution",
    serverUrl: normalizeEvolutionUrl(whatsappApi.serverUrl || whatsappApi.url || process.env.EVOLUTION_API_URL),
    instanceId,
    instanceToken,
    apiKey: text(whatsappApi.apiKey || process.env.EVOLUTION_API_KEY),
    webhookUrl: text(whatsappApi.webhookUrl),
    testRecipient: text(whatsappApi.testRecipient || process.env.EVOLUTION_TEST_RECIPIENT) || DEFAULT_EVOLUTION_TEST_RECIPIENT,
    connectedNumber: text(whatsappApi.connectedNumber || ""),
    enabled: whatsappApi.enabled === undefined ? configured : whatsappApi.enabled !== false,
    failsafe: {
      mode: failsafeMode as any,
      notifyAdminEmail: text(failsafeRaw.notifyAdminEmail || ""),
    },
  }
}

export function isWhatsappDeliveryEnabled(settings?: EvolutionSettings): boolean {
  if (!settings) return true
  return settings.enabled !== false
}

export function publicEvolutionSettings(settings: EvolutionSettings): EvolutionPublicSettings {
  return {
    provider: "evolution",
    serverUrl: settings.serverUrl,
    instanceId: settings.instanceId,
    webhookUrl: settings.webhookUrl,
    testRecipient: settings.testRecipient,
    connectedNumber: settings.connectedNumber,
    apiKeyConfigured: Boolean(settings.apiKey),
    instanceTokenConfigured: Boolean(settings.instanceToken),
    enabled: settings.enabled,
    failsafe: settings.failsafe,
  }
}

type EvolutionSettingsInput = Partial<EvolutionSettings>

export async function updateEvolutionSettings(input: EvolutionSettingsInput, updatedBy?: string | null) {
  const existing = await getRuntimeIntegrationConfig({ decrypted: true, masked: false }).catch(() => ({} as any))
  const previous = object((existing as any).whatsappApi)
  const current = { ...(previous as any) }
  for (const key of LEGACY_EVOLUTION_KEYS) delete current[key]
  const previousToken = previous.instanceToken || ""
  const nextToken = input.instanceToken ?? previousToken
  const instanceId = text(input.instanceId ?? previous.instanceId)
  const previousFailsafe = object((previous as any).failsafe)
  const failsafeRaw = object(input.failsafe)
  const failsafeMode = text(failsafeRaw.mode) ? normalizeFailsafeMode(text(failsafeRaw.mode)) : normalizeFailsafeMode(text(previousFailsafe.mode))
  const next = {
    ...existing,
    whatsappApi: {
      ...current,
      provider: "evolution",
      serverUrl: normalizeEvolutionUrl(input.serverUrl ?? previous.serverUrl),
      instanceId,
      instanceToken: /^\*{6,}$/.test(text(nextToken)) ? previousToken || "" : text(nextToken),
      apiKey: /^\*{6,}$/.test(text(input.apiKey)) ? previous.apiKey || "" : text(input.apiKey ?? previous.apiKey),
      webhookUrl: text(input.webhookUrl ?? previous.webhookUrl),
      testRecipient: text(input.testRecipient ?? previous.testRecipient) || DEFAULT_EVOLUTION_TEST_RECIPIENT,
      connectedNumber: text(input.connectedNumber ?? previous.connectedNumber),
      enabled: input.enabled === undefined ? (previous.enabled === undefined ? true : previous.enabled) : Boolean(input.enabled),
      failsafe: {
        mode: failsafeMode,
        notifyAdminEmail: text(failsafeRaw.notifyAdminEmail ?? previousFailsafe.notifyAdminEmail),
      },
    },
  }
  const saved = await updateRuntimeIntegrationConfig(next as any, updatedBy || null)
  await (prisma as any).runtimeIntegration.updateMany({
    where: { provider: "whatsappApi", keyName: { in: LEGACY_EVOLUTION_KEYS } },
    data: { keyValueEncrypted: "", isEnabled: false },
  }).catch(() => null)
  const settings = await getEvolutionSettings()
  return { saved, settings: publicEvolutionSettings(settings), privateSettings: settings }
}

export function assertEvolutionConfigured(settings: EvolutionSettings) {
  if (!settings.serverUrl) throw new Error("Evolution API server URL is not configured.")
  if (!evolutionInstanceIdentifier(settings)) throw new Error("Evolution API instance ID is not configured.")
  if (!settings.apiKey) throw new Error("Evolution API key is not configured.")
}

/**
 * Probes our own public webhook URL.
 *
 * This is a request back through the proxy to ourselves, so it needs an
 * explicit bound: if the app is saturated the self-call queues behind the very
 * health check that issued it, and without a timeout the check waits on itself
 * indefinitely.
 */
async function probeWebhook(url: string) {
  if (!url) return { ok: false, message: "Webhook URL is not configured." }
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_EVOLUTION_TIMEOUT_MS),
    })
    return { ok: response.ok, message: response.ok ? "Webhook endpoint reachable." : "Webhook unreachable." }
  } catch {
    return { ok: false, message: "Webhook unreachable." }
  }
}

function sameUrl(left: string, right: string) {
  return text(left).replace(/\/+$/, "") === text(right).replace(/\/+$/, "")
}

export function defaultEvolutionWebhookUrl() {
  const base = text(process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL)
  return base ? `${base.replace(/\/+$/, "")}/api/whatsapp/webhook` : ""
}

export async function testEvolutionConnection(settingsInput?: EvolutionSettings, options: { webhookUrl?: string; registerWebhook?: boolean; realSendAccepted?: boolean } = {}): Promise<EvolutionConnectionResult> {
  const settings = settingsInput || await getEvolutionSettings()
  const instanceId = evolutionInstanceIdentifier(settings)
  const webhookUrl = text(options.webhookUrl || settings.webhookUrl || defaultEvolutionWebhookUrl())
  const checks: EvolutionConnectionCheck[] = []

  if (!settings.serverUrl || !settings.apiKey || !instanceId) {
    checks.push(check("api_reachable", "API reachable", Boolean(settings.serverUrl), settings.serverUrl ? "Server URL configured." : "Server URL is required."))
    checks.push(check("api_key_valid", "API key valid", Boolean(settings.apiKey), settings.apiKey ? "API key configured." : "Global API key is required."))
    checks.push(check("instance_exists", "Instance exists", Boolean(instanceId), instanceId ? "Instance ID configured." : "Instance ID is required."))
    checks.push(check("instance_connected", "Instance connected", false, "Connection check skipped until configuration is complete."))
    checks.push(check("send_endpoint_valid", "Send endpoint valid", false, "Send endpoint check skipped until configuration is complete."))
    if (options.realSendAccepted !== undefined) checks.push(check("real_send_accepted", "Real send accepted", false, "Real send skipped until configuration is complete."))
    checks.push(check("webhook_reachable", "Webhook reachable", false, "Webhook check skipped until configuration is complete."))
    checks.push(check("webhook_configured", "Webhook configured", false, "Webhook check skipped until configuration is complete."))
    return {
      ok: false,
      status: "FAIL",
      provider: "evolution",
      apiValid: Boolean(settings.apiKey),
      instanceFound: Boolean(instanceId),
      connected: false,
      webhookReachable: false,
      webhookConfigured: false,
      instanceId,
      connectionState: "not_configured",
      connectedNumber: "",
      sendInstance: instanceId,
      checks,
    }
  }

  const client = createEvolutionClient(settings)
  // A status probe only has to prove reachability, so it uses a short bound
  // rather than the generous production-send timeout.
  const probeOptions = { timeoutMs: PROBE_EVOLUTION_TIMEOUT_MS }

  // Reachability and the instance lookup do not depend on each other, so they
  // run together. Sequentially this cost the sum of every upstream round trip,
  // which is what pushed the probe past the health check's budget.
  let apiVersion = "unknown"
  let instances: unknown = null
  let instance: any = null

  const [versionResult, instanceResult] = await Promise.allSettled([
    client.getVersion(probeOptions),
    client.findInstance(instanceId, probeOptions),
  ])

  if (versionResult.status === "fulfilled") {
    apiVersion = versionResult.value
    checks.push(check("api_reachable", "API reachable", true, `Evolution API is reachable${apiVersion !== "unknown" ? ` (version ${apiVersion})` : ""}.`))
  } else {
    checks.push(check("api_reachable", "API reachable", false, friendlyError(versionResult.reason)))
  }

  if (instanceResult.status === "fulfilled") {
    instances = instanceResult.value.instances
    instance = instanceResult.value.instance
    checks.push(check("api_key_valid", "API key valid", true, "Global API key accepted."))
    checks.push(check("instance_exists", "Instance exists", Boolean(instance), instance ? "Instance found." : "Instance not found."))
  } else {
    checks.push(check("api_key_valid", "API key valid", false, friendlyError(instanceResult.reason)))
    checks.push(check("instance_exists", "Instance exists", false, "Instance lookup failed."))
  }

  let connectionState = instance ? connectionStateFromInstance(instance) : ""
  const sendInstance = instance ? sendIdentifierFromInstance(instance, instanceId) : instanceId
  if (instance) {
    try {
      const stateBody: any = await client.connectionState(sendInstance, probeOptions)
      connectionState = text(stateBody?.instance?.state || stateBody?.instance?.connectionStatus || stateBody?.state || stateBody?.connectionState || connectionState || "unknown").toLowerCase()
    } catch {
      connectionState = connectionState || "unknown"
    }
  }
  const connected = connectionStatusFromState(connectionState) === "Connected"
  checks.push(check("instance_connected", "Instance connected", connected, connected ? "Instance is connected." : "Instance is disconnected."))
  checks.push(check("send_endpoint_valid", "Send endpoint valid", Boolean(instance && sendInstance), sendInstance ? `Send endpoint resolved for instance "${sendInstance}".` : "Send endpoint could not resolve an Evolution instance identifier."))
  if (options.realSendAccepted !== undefined) {
    checks.push(check("real_send_accepted", "Real send accepted", options.realSendAccepted, options.realSendAccepted ? "Evolution accepted the real production test payload." : "Evolution did not accept a real production test payload."))
  }

  // The webhook self-probe and the remote webhook lookup are independent, so
  // they run together.
  const webhookWork = (async () => {
    if (!instance || !webhookUrl) return null
    try {
      if (options.registerWebhook) await client.setWebhook(sendInstance, webhookUrl, EVOLUTION_WEBHOOK_EVENTS, probeOptions)
      return await client.findWebhook(sendInstance, probeOptions)
    } catch {
      return null
    }
  })()

  const webhookProbe = await probeWebhook(webhookUrl)
  const webhook = await webhookWork
  checks.push(check("webhook_reachable", "Webhook reachable", webhookProbe.ok, webhookProbe.message))

  let webhookConfigured = false
  if (instance && webhookUrl) {
    try {
      if (webhook) {
        const remoteUrl = webhookUrlFromEvolution(webhook)
        const remoteEvents = webhookEventsFromEvolution(webhook)
        const hasEvents = EVOLUTION_WEBHOOK_EVENTS.every((event) => remoteEvents.includes(event))
        webhookConfigured = sameUrl(remoteUrl, webhookUrl) && hasEvents
        checks.push(check("webhook_configured", "Webhook configured", webhookConfigured, webhookConfigured ? "Evolution webhook is configured." : "Evolution webhook is missing required URL or events."))
      } else {
        // A null body means Evolution simply has no webhook registered, which
        // is different from the API refusing the request.
        checks.push(check("webhook_configured", "Webhook configured", false, "Evolution webhook could not be read from the API."))
      }
    } catch (error) {
      checks.push(check("webhook_configured", "Webhook configured", false, friendlyError(error)))
    }
  } else {
    checks.push(check("webhook_configured", "Webhook configured", false, "Webhook registration skipped because the instance or URL is missing."))
  }

  const apiValid = checks.find((entry) => entry.key === "api_key_valid")?.ok || false
  const instanceFound = Boolean(instance)
  const webhookReachable = webhookProbe.ok
  const ok = checks.every((entry) => entry.ok)
  return {
    ok,
    status: ok ? "PASS" : "FAIL",
    provider: "evolution",
    apiValid,
    instanceFound,
    connected,
    webhookReachable,
    webhookConfigured,
    instanceId,
    connectionState: connectionState || "unknown",
    connectedNumber: connectedNumberFromInstance(instance) || settings.connectedNumber,
    sendInstance,
    apiVersion,
    checks,
    instance,
    instances,
    webhook,
  }
}

export async function getEvolutionStatus() {
  const settings = await getEvolutionSettings()
  const configured = Boolean(settings.serverUrl && evolutionInstanceIdentifier(settings) && settings.apiKey)
  if (!configured) {
    return {
      provider: "evolution",
      configured: false,
      connected: false,
      status: "DISCONNECTED",
      connectionState: "not_configured",
      settings: publicEvolutionSettings(settings),
      raw: null,
    }
  }
  const probe = await testEvolutionConnection(settings)
  const connectedNumber = probe.connectedNumber || settings.connectedNumber
  return {
    provider: "evolution",
    configured: true,
    connected: probe.connected,
    status: probe.connected ? "CONNECTED" : "DISCONNECTED",
    connectionState: probe.connectionState || "unknown",
    statusCode: probe.status,
    apiValid: probe.apiValid,
    instanceFound: probe.instanceFound,
    webhookReachable: probe.webhookReachable,
    webhookConfigured: probe.webhookConfigured,
    connectedNumber,
    settings: publicEvolutionSettings({ ...settings, connectedNumber }),
    raw: { checks: probe.checks },
  }
}

export async function verifyEvolutionApi() {
  const settings = await getEvolutionSettings()
  assertEvolutionConfigured(settings)
  const status = await testEvolutionConnection(settings)
  const failed = status.checks.find((entry) => !entry.ok && entry.key !== "webhook_reachable" && entry.key !== "webhook_configured")
  if (failed) throw new Error(failed.message)
  return {
    provider: "evolution",
    configured: true,
    instanceId: evolutionInstanceIdentifier(settings),
    webhookConfigured: status.webhookConfigured,
    connected: status.connected,
    connectedNumber: status.connectedNumber || null,
    apiStatus: status.apiValid ? "ok" : "failed",
    instanceFound: status.instanceFound,
    instance: status.instance,
    instances: status.instances,
    sendInstance: status.sendInstance,
    status,
  }
}

async function resolveEvolutionSendInstance(settings: EvolutionSettings) {
  const status = await testEvolutionConnection(settings)
  const failed = status.checks.find((entry) => !entry.ok && ["api_reachable", "api_key_valid", "instance_exists", "instance_connected"].includes(entry.key))
  if (failed) throw new Error(failed.message)
  return status.sendInstance || evolutionInstanceIdentifier(settings)
}

export async function sendEvolutionText(input: { to: string; message: string; delay?: number; linkPreview?: boolean }) {
  const normalized = normalizeWhatsAppNumber(input.to)
  const settings = await getEvolutionSettings()
  assertEvolutionConfigured(settings)
  const sendInstance = await resolveEvolutionSendInstance(settings)
  const client = createEvolutionClient(settings)
  const sent = await client.sendText(sendInstance, {
    number: normalized.digits,
    text: input.message,
    delay: input.delay || 0,
    linkPreview: input.linkPreview !== false,
  })
  return {
    ok: true as const,
    status: "whatsapp_server_ack",
    messageId: sent.messageId || `evolution-${Date.now()}`,
    toMasked: normalized.maskedPhone,
    phoneHash: normalized.phoneHash,
    providerResponse: sent.body,
    timestamp: new Date().toISOString(),
  }
}

export async function sendEvolutionMedia(input: { to: string; filePath?: string; mediaUrl?: string; caption?: string | null; mediaType?: string }) {
  const normalized = normalizeWhatsAppNumber(input.to)
  const settings = await getEvolutionSettings()
  assertEvolutionConfigured(settings)
  const sendInstance = await resolveEvolutionSendInstance(settings)
  const media = input.mediaUrl || input.filePath
  if (!media) throw new Error("Evolution media send requires mediaUrl or filePath.")
  const client = createEvolutionClient(settings)
  const sent = await client.sendMedia(sendInstance, {
    number: normalized.digits,
    mediatype: input.mediaType || "document",
    media,
    caption: input.caption || "",
  })
  return {
    ok: true as const,
    status: "whatsapp_server_ack",
    messageId: sent.messageId || `evolution-${Date.now()}`,
    toMasked: normalized.maskedPhone,
    phoneHash: normalized.phoneHash,
    providerResponse: sent.body,
    timestamp: new Date().toISOString(),
  }
}

export function maskEvolutionDestination(value: string) {
  return maskWhatsAppPhone(value)
}

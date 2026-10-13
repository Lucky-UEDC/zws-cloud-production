export const EVOLUTION_WEBHOOK_EVENTS = [
  "MESSAGES_UPSERT",
  "SEND_MESSAGE",
  "MESSAGES_UPDATE",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
] as const

export type EvolutionWebhookEvent = (typeof EVOLUTION_WEBHOOK_EVENTS)[number]

export type EvolutionClientSettings = {
  serverUrl: string
  apiKey: string
}

export type EvolutionRequestOptions = {
  method?: string
  body?: unknown
  headers?: HeadersInit
  /**
   * How long to wait for this call before giving up.
   *
   * The default is deliberately generous: this client is also the production
   * send path, and cutting a real message delivery short because an upstream
   * was slow would be worse than waiting. Status probes pass a much shorter
   * value via `testEvolutionConnection`, because a probe has no business
   * holding a request open for a minute.
   */
  timeoutMs?: number
}

/** Bound applied when a caller does not choose one. Sized for real sends. */
export const DEFAULT_EVOLUTION_TIMEOUT_MS = 30_000

/** Bound applied to status probes, which only need to prove reachability. */
export const PROBE_EVOLUTION_TIMEOUT_MS = 4_000

export class EvolutionApiError extends Error {
  status: number
  code: string
  friendlyMessage: string
  responseBody: unknown
  path?: string

  constructor(input: { status: number; statusText?: string; body?: unknown; path?: string }) {
    const friendlyMessage = friendlyEvolutionError(input.status, input.body)
    super(friendlyMessage)
    this.name = "EvolutionApiError"
    this.status = input.status
    this.code = evolutionErrorCode(input.status)
    this.friendlyMessage = friendlyMessage
    this.responseBody = input.body
    this.path = input.path
  }
}

function text(value: unknown) {
  return String(value || "").trim()
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function normalizeEvolutionUrl(value: unknown) {
  const cleaned = text(value).replace(/\/+$/, "")
  if (!cleaned) return ""
  return /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`
}

export function evolutionErrorCode(status: number) {
  if (status === 401 || status === 403) return "invalid_api_key"
  if (status === 404) return "not_found"
  if (status === 429) return "rate_limited"
  if (status >= 500) return "server_unavailable"
  return "request_failed"
}

export function friendlyEvolutionError(status: number, body?: unknown) {
  const remoteMessage = typeof body === "object"
    ? text((body as any)?.message || (body as any)?.error)
    : text(body)
  if (status === 401 || status === 403) return "API key invalid"
  if (status === 404) return "Instance not found or Evolution endpoint unavailable"
  if (status === 429) return "Evolution API rate limit reached"
  if (status >= 500) return "Evolution server unavailable"
  return remoteMessage || "Evolution API request failed"
}

export function isEvolutionApiError(error: unknown): error is EvolutionApiError {
  return error instanceof EvolutionApiError
}

function asArray(value: unknown): any[] {
  if (Array.isArray(value)) return value
  const record = object(value)
  for (const key of ["instances", "data", "response", "result"]) {
    const candidate = record[key]
    if (Array.isArray(candidate)) return candidate
  }
  return value && typeof value === "object" ? [value] : []
}

export function instanceMatchCandidates(row: any) {
  return [
    row?.instanceName,
    row?.instanceId,
    row?.instance,
    row?.name,
    row?.id,
    row?.instance?.instanceName,
    row?.instance?.instanceId,
    row?.instance?.instance,
    row?.instance?.name,
    row?.instance?.id,
  ].map(text).filter(Boolean)
}

export function connectionStateFromInstance(row: any) {
  return text(
    row?.instance?.state ||
    row?.instance?.connectionStatus ||
    row?.instance?.status ||
    row?.state ||
    row?.connectionState ||
    row?.connectionStatus ||
    row?.status ||
    row?.statusInstance,
  ).toLowerCase()
}

export function connectedNumberFromInstance(row: any) {
  return text(row?.instance?.ownerJid || row?.instance?.profileName || row?.instance?.number || row?.ownerJid || row?.number)
}

export function connectionStatusFromState(state: string) {
  return ["open", "connected", "online", "ready"].includes(text(state).toLowerCase()) ? "Connected" : "Disconnected"
}

export function findEvolutionInstance(instancesBody: unknown, instanceId: string) {
  const wanted = text(instanceId).toLowerCase()
  if (!wanted) return null
  return asArray(instancesBody).find((row) => instanceMatchCandidates(row).some((candidate) => candidate.toLowerCase() === wanted)) || null
}

export function sendIdentifierFromInstance(row: any, fallback: string) {
  return text(
    row?.instanceName ||
    row?.instance?.instanceName ||
    row?.name ||
    row?.instance?.name ||
    row?.instance ||
    row?.instance?.instance ||
    fallback,
  )
}

function responseMessages(body: unknown) {
  const values: string[] = []
  const visit = (value: unknown) => {
    if (typeof value === "string") {
      values.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>
      for (const key of ["message", "error", "response"]) visit(record[key])
    }
  }
  visit(body)
  return values.join(" ").toLowerCase()
}

function shouldRetryLegacyTextPayload(error: unknown) {
  if (!isEvolutionApiError(error)) return false
  if (![400, 404].includes(error.status)) return false
  const message = responseMessages(error.responseBody)
  return (
    message.includes("textmessage") ||
    message.includes("text message") ||
    message.includes("requires property") ||
    message.includes("instance does not exist") ||
    message.includes("not found")
  )
}

function messageIdFromEvolution(body: any) {
  return text(body?.key?.id || body?.messageId || body?.id || body?.data?.key?.id || body?.data?.messageId)
}

function webhookRecord(body: unknown) {
  const root = object(body) as any
  return object(root.webhook || root.data?.webhook || root.response?.webhook || root.result?.webhook || root)
}

export function webhookUrlFromEvolution(body: unknown) {
  const record = webhookRecord(body) as any
  return text(record.url || record.webhookUrl || record.webhook?.url)
}

export function webhookEventsFromEvolution(body: unknown) {
  const record = webhookRecord(body) as any
  const events = record.events || record.webhook?.events
  return Array.isArray(events) ? events.map(text).filter(Boolean) : []
}

export class EvolutionClient {
  private baseUrl: string
  private apiKey: string

  constructor(settings: EvolutionClientSettings) {
    this.baseUrl = normalizeEvolutionUrl(settings.serverUrl)
    this.apiKey = text(settings.apiKey)
  }

  private async request(path: string, options: EvolutionRequestOptions = {}) {
    const url = `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`
    const timeoutMs = Math.max(500, Math.trunc(Number(options.timeoutMs) || DEFAULT_EVOLUTION_TIMEOUT_MS))
    let response: Response
    try {
      // Every call is bounded. Without this a single unresponsive upstream left
      // a fetch pending forever, and the health check inherited that hang
      // because it probes several of these in sequence.
      response = await fetch(url, {
        method: options.method || "GET",
        headers: {
          "Content-Type": "application/json",
          apikey: this.apiKey,
          Authorization: `apikey ${this.apiKey}`,
          ...(options.headers || {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      const error = new Error("Evolution server unavailable")
      ;(error as Error & { status?: number; code?: string }).status = 503
      ;(error as Error & { status?: number; code?: string }).code = "server_unavailable"
      throw error
    }

    const textBody = await response.text()
    let body: unknown = null
    try {
      body = textBody ? JSON.parse(textBody) : null
    } catch {
      body = textBody
    }

    if (!response.ok) {
      throw new EvolutionApiError({ status: response.status, statusText: response.statusText, body, path })
    }
    return body
  }

  getInfo(options: EvolutionRequestOptions = {}) {
    return this.request("/", options)
  }

  async getVersion(options: EvolutionRequestOptions = {}) {
    const info: any = await this.getInfo(options)
    return text(info?.version || info?.data?.version || info?.response?.version || info?.result?.version || "unknown")
  }

  fetchInstances(options: EvolutionRequestOptions = {}) {
    return this.request("/instance/fetchInstances", options)
  }

  async findInstance(instanceId: string, options: EvolutionRequestOptions = {}) {
    const instances = await this.fetchInstances(options)
    return { instances, instance: findEvolutionInstance(instances, instanceId) }
  }

  connectionState(instance: string, options: EvolutionRequestOptions = {}) {
    return this.request(`/instance/connectionState/${encodeURIComponent(instance)}`, options)
  }

  setWebhook(instance: string, url: string, events: readonly EvolutionWebhookEvent[] = EVOLUTION_WEBHOOK_EVENTS, options: EvolutionRequestOptions = {}) {
    const webhook = {
      enabled: true,
      url,
      webhookByEvents: true,
      webhookBase64: true,
      events: [...events],
    }
    return this.request(`/webhook/set/${encodeURIComponent(instance)}`, {
      ...options,
      method: "POST",
      body: webhook,
    }).catch((error) => {
      if (isEvolutionApiError(error) && error.status === 400) {
        return this.request(`/webhook/set/${encodeURIComponent(instance)}`, {
          ...options,
          method: "POST",
          body: { webhook },
        })
      }
      throw error
    })
  }

  findWebhook(instance: string, options: EvolutionRequestOptions = {}) {
    return this.request(`/webhook/find/${encodeURIComponent(instance)}`, options)
  }

  async sendText(instance: string, input: { number: string; text: string; delay?: number; linkPreview?: boolean }) {
    const path = `/message/sendText/${encodeURIComponent(instance)}`
    const modernPayload = {
      number: input.number,
      text: input.text,
      delay: input.delay || 0,
      linkPreview: input.linkPreview !== false,
    }
    const legacyPayload = {
      number: input.number,
      textMessage: { text: input.text },
      options: {
        delay: input.delay || 0,
        presence: "composing",
        linkPreview: input.linkPreview !== false,
      },
    }
    const body = await this.request(path, { method: "POST", body: modernPayload }).catch((error) => {
      if (shouldRetryLegacyTextPayload(error)) return this.request(path, { method: "POST", body: legacyPayload })
      throw error
    })
    return { body, messageId: messageIdFromEvolution(body) }
  }

  async sendMedia(instance: string, input: { number: string; mediatype: string; media: string; caption?: string | null }) {
    const body = await this.request(`/message/sendMedia/${encodeURIComponent(instance)}`, {
      method: "POST",
      body: {
        number: input.number,
        mediatype: input.mediatype,
        media: input.media,
        caption: input.caption || "",
      },
    })
    return { body, messageId: messageIdFromEvolution(body) }
  }
}

export function createEvolutionClient(settings: EvolutionClientSettings) {
  return new EvolutionClient(settings)
}

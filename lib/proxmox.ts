import dns from "node:dns/promises"
import net from "node:net"
import http from "node:http"
import https from "node:https"
import tls from "node:tls"
import { decryptSecretValue, isEncryptedSecret } from "@/lib/secret-crypto"

export const PROXMOX_NODE_TIMEOUT_MS = 5000
export const PROXMOX_STORAGE_TIMEOUT_MS = 5000
export const PROXMOX_VM_TIMEOUT_MS = 10000
export const PROXMOX_INVENTORY_TIMEOUT_MS = 5000
export const PROXMOX_METRICS_TIMEOUT_MS = PROXMOX_VM_TIMEOUT_MS
export const PROXMOX_VALIDATION_TIMEOUT_MS = 30000
export const PROXMOX_LONG_TIMEOUT_MS = 60000
export const DEFAULT_PROXMOX_TIMEOUT_MS = PROXMOX_METRICS_TIMEOUT_MS
export const PROXMOX_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

const keepAliveAgents = new Map<string, http.Agent | https.Agent>()

function agentForProtocol(protocol: string): http.Agent | https.Agent {
  const existing = keepAliveAgents.get(protocol)
  if (existing) return existing
  const agent =
    protocol === "http:"
      ? new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, scheduling: "lifo" })
      : new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8, scheduling: "lifo" })
  keepAliveAgents.set(protocol, agent)
  return agent
}

class ProxmoxError extends Error {
  public layer: string
  public endpoint: string | null
  public code: ProxmoxErrorCode
  public httpStatus: number | null
  public proxmoxMessage: string | null
  public proxmoxResponse: unknown

  constructor(public status: number, message: string, options: { layer?: string; endpoint?: string | null; code?: ProxmoxErrorCode; httpStatus?: number | null; proxmoxMessage?: string | null; proxmoxResponse?: unknown } = {}) {
    super(message)
    this.name = "ProxmoxError"
    this.layer = options.layer || "proxmox"
    this.endpoint = options.endpoint || null
    this.code = options.code || codeForStatus(status)
    this.httpStatus = options.httpStatus ?? null
    this.proxmoxMessage = options.proxmoxMessage ?? null
    this.proxmoxResponse = options.proxmoxResponse
  }
}

export type ProxmoxErrorCode =
  | "DNS_FAILED"
  | "TCP_TIMEOUT"
  | "TCP_REFUSED"
  | "TLS_CERT_ERROR"
  | "TLS_HANDSHAKE_ERROR"
  | "HTTP_TIMEOUT"
  | "AUTH_FAILED_401"
  | "PERMISSION_DENIED_403"
  | "NOT_FOUND_404"
  | "VM_NOT_FOUND"
  | "TEMPLATE_MISSING"
  | "STORAGE_UNAVAILABLE"
  | "VMID_CONFLICT"
  | "INSUFFICIENT_RESOURCES"
  | "NETWORK_BRIDGE_MISSING"
  | "NETWORK_CONFIG_INVALID"
  | "CLONE_FAILED"
  | "RESPONSE_TOO_LARGE"
  | "PROXMOX_NOT_JSON"
  | "NODE_NOT_FOUND"
  | "API_ERROR"
  | "CONSOLE_UNSUPPORTED"
  | "TERMPROXY_UNSUPPORTED"
  | "SNAPSHOT_UNSUPPORTED"
  | "BACKUP_UNSUPPORTED"
  | "GUEST_AGENT_UNAVAILABLE"
  | "UNKNOWN_ERROR"

export type ProxmoxDiagnosticStep = {
  name: string
  ok: boolean
  code: ProxmoxErrorCode | "OK"
  message: string
  durationMs: number
  endpoint?: string | null
  status?: number | null
  address?: string | null
  addresses?: string[]
}

export type ProxmoxDiagnosticResult = {
  ok: boolean
  host: string
  nodeName: string
  message: string
  code: ProxmoxErrorCode | "OK"
  steps: ProxmoxDiagnosticStep[]
  nodes: string[]
  matchedNode: ProxmoxNodeSummary | null
}

export interface ProxmoxVM {
  vmid: number
  name: string
  status: "running" | "stopped" | "paused"
  cpus: number
  maxmem: number
  maxdisk: number
  uptime: number
  node: string
}

export interface ProxmoxVMCreateConfig {
  name: string
  memory: number
  cores: number
  sockets: number
  scsi0: string
  net0: string
  ostemplate: string
  [key: string]: any
}

export interface ProxmoxVNCTicket {
  port: number
  ticket: string
  cert: string
}

export interface ProxmoxVMRestoreConfig {
  vmid: number
  name: string
  restore: string
  storage?: string
}

export type ProxmoxStorageSummary = {
  storage: string
  type?: string
  enabled?: number
  active?: number
  total?: number
  used?: number
  avail?: number
}

export type ProxmoxStorageContent = {
  volid: string
  content: string
  format?: string
  size?: number
}

export type ProxmoxNodeSummary = {
  node: string
  status: string
  enabled: boolean
}

export type ProxmoxLxcSummary = {
  vmid: number
  name?: string
  status?: string
  cpus?: number
  maxmem?: number
  maxdisk?: number
  uptime?: number
  template?: number
}

export type ProxmoxClientOptions = {
  allowInsecureTls?: boolean
  timeoutMs?: number
  allowEmptyHost?: boolean
  logRequests?: boolean
  retries?: number
  maxResponseBytes?: number
}

type ProxmoxResponse<T> = {
  data: T
  statusCode: number
}

export type ProxmoxRequestOptions = {
  host: string
  tokenId: string
  tokenSecret: string
  endpoint: string
  method?: string
  body?: any
  allowInsecureTls?: boolean
  timeoutMs?: number
  allowEmptyHost?: boolean
  logRequests?: boolean
  retries?: number
  maxResponseBytes?: number
}

function unquoteConfigValue(value: string): string {
  const trimmed = String(value || "").trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim()
  }
  return trimmed
}

export type ProxmoxStartResult = ProxmoxResponse<any> & {
  method: "POST"
  path: string
  upid: string | null
}

function codeForStatus(status: number): ProxmoxErrorCode {
  if (status === 401) return "AUTH_FAILED_401"
  if (status === 403) return "PERMISSION_DENIED_403"
  if (status === 404) return "NOT_FOUND_404"
  if (status === 504) return "HTTP_TIMEOUT"
  if (status >= 500) return "API_ERROR"
  return "UNKNOWN_ERROR"
}

function classifyProxmoxApiError(status: number, endpoint: string, fallback?: unknown): ProxmoxErrorCode {
  const text = proxmoxDetailText(fallback).toLowerCase()
  const path = String(endpoint || "").toLowerCase()
  if (status === 401) return "AUTH_FAILED_401"
  if (status === 403) return "PERMISSION_DENIED_403"
  if (/configuration file .*qemu-server\/\d+\.conf.*does not exist|no such vm|vm \d+ not found|does not exist/i.test(text)) {
    if (/\/clone$/.test(path) || /template/.test(text)) return "TEMPLATE_MISSING"
    return "VM_NOT_FOUND"
  }
  if (status === 404 && /\/qemu\/\d+/.test(path)) return "VM_NOT_FOUND"
  if (status === 404 && /template|storage\/.+\/content/.test(path)) return "TEMPLATE_MISSING"
  if (/already exists|vmid.*exist|newid.*exist|duplicate/.test(text)) return "VMID_CONFLICT"
  if (/not enough|insufficient|no space|out of space|quota|resource|memory|ram|cpu/.test(text)) return "INSUFFICIENT_RESOURCES"
  if (/storage.*(not|unavailable|disabled|inactive|unknown)|no such storage|datastore|does not support content/.test(text)) return "STORAGE_UNAVAILABLE"
  if (/(bridge).+(not|missing|unknown|invalid|does not exist|unavailable|no such)|invalid (bridge|net0|network)|bridge.*(error|failed)/i.test(text) && /bridge|vlan|net0|network/.test(text)) return "NETWORK_BRIDGE_MISSING"
  if (/parameter verification failed|invalid format|net0\.model|net\d+\./i.test(text)) return "NETWORK_CONFIG_INVALID"
  if (/vmbr\d+/.test(text) && /bridge/i.test(text) && /(not|missing|unknown|invalid|does not exist|unavailable|no such)/i.test(text)) return "NETWORK_BRIDGE_MISSING"
  if (/clone|qmclone/.test(path) || /clone|qmclone/.test(text)) return "CLONE_FAILED"
  if (status === 404) return "NOT_FOUND_404"
  return codeForStatus(status)
}

export function normalizeProxmoxHost(host: string): string {
  const trimmed = unquoteConfigValue(host).replace(/\/+$/, "")
  if (!trimmed) {
    throw new ProxmoxError(400, "Invalid Proxmox endpoint")
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withProtocol)
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) {
      throw new Error("Invalid Proxmox endpoint")
    }
    const hostname = url.hostname
    const hostForUrl = hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname
    const port = url.port || "8006"
    return `${url.protocol}//${hostForUrl}:${port}`
  } catch {
    throw new ProxmoxError(400, "Invalid Proxmox endpoint")
  }
}

function proxmoxUrlParts(host: string) {
  const url = new URL(normalizeProxmoxHost(host))
  return {
    url,
    hostname: url.hostname,
    port: Number(url.port || 8006),
    host: `${url.protocol}//${url.host}`,
  }
}

export function normalizeProxmoxEndpoint(endpoint: string): string {
  const trimmed = String(endpoint || "").trim()
  if (!trimmed) return "/api2/json"

  let pathname = trimmed
  let search = ""

  try {
    const asUrl = new URL(trimmed)
    pathname = asUrl.pathname
    search = asUrl.search
  } catch {
    const queryIndex = trimmed.indexOf("?")
    if (queryIndex >= 0) {
      pathname = trimmed.slice(0, queryIndex)
      search = trimmed.slice(queryIndex)
    }
  }

  let withoutPrefix = pathname.replace(/^\/+/, "")
  while (/^api2\/json\/?/i.test(withoutPrefix)) {
    withoutPrefix = withoutPrefix
      .replace(/^api2\/json\/?/i, "")
      .replace(/^\/+/, "")
  }

  return withoutPrefix ? `/api2/json/${withoutPrefix}${search}` : `/api2/json${search}`
}

export function normalizeProxmoxTokenId(tokenId: string): string {
  const normalized = unquoteConfigValue(tokenId)
  if (/PVEAPIToken=/i.test(normalized)) {
    throw new ProxmoxError(400, "Token ID must not include PVEAPIToken=", { layer: "config", code: "API_ERROR" })
  }
  if (normalized.includes("=")) {
    throw new ProxmoxError(400, "Token ID must not include the token secret", { layer: "config", code: "API_ERROR" })
  }
  return normalized
}

export function buildProxmoxAuthorizationHeader(tokenId: string, tokenSecret: string): string {
  return `PVEAPIToken=${normalizeProxmoxTokenId(tokenId)}=${unquoteConfigValue(tokenSecret)}`
}

function safeProxmoxMessage(message: unknown) {
  return String(message || "Proxmox API error")
    .replace(/PVEAPIToken=[^\s"'<>]+/gi, "PVEAPIToken=[redacted]")
    .replace(/PVEAuthCookie=[^;\s"'<>]+/gi, "PVEAuthCookie=[redacted]")
}

function proxmoxDetailText(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "string") return safeProxmoxMessage(value)
  if (typeof value !== "object") return safeProxmoxMessage(String(value))
  const object = value as Record<string, any>
  const candidates = [
    object.message,
    object.error,
    object.errors,
    object.data?.message,
    object.data?.error,
    object.data?.errors,
    object.response?.message,
    object.response?.error,
  ]
  const direct = candidates.find((entry) => typeof entry === "string" && entry.trim())
  if (direct) return safeProxmoxMessage(direct)
  try {
    return safeProxmoxMessage(JSON.stringify(value))
  } catch {
    return "Proxmox API error"
  }
}

/**
 * Per-call request logging.
 *
 * Off by default. Every `getVMConfig` and every guest verb logged a line, so a
 * 30-second telemetry sweep or a QA run buried its own output — the tool's result
 * became unreadable in the middle of the transport chatter it was trying to
 * report through. Failures are never suppressed: those are what an operator is
 * looking for.
 *
 * Set `PROXMOX_LOG=all` (or `=requests`, `=ok`, `=fail`) when debugging a call.
 */
const PROXMOX_LOG_LEVELS = (() => {
  const raw = String(process.env.PROXMOX_LOG || "").trim().toLowerCase()
  if (!raw || raw === "off" || raw === "none") return { request: false, ok: false, fail: true }
  if (raw === "all" || raw === "true" || raw === "1") return { request: true, ok: true, fail: true }
  const set = new Set(raw.split(",").map((entry) => entry.trim()))
  return { request: set.has("request") || set.has("requests"), ok: set.has("ok"), fail: set.has("fail") || set.has("all") }
})()

function proxmoxLog(event: "request" | "ok" | "fail", fields: Record<string, unknown>) {
  if (event === "request") {
    if (PROXMOX_LOG_LEVELS.request) console.log("[proxmox] request", { endpoint: fields.endpoint, attempt: fields.attempt, timeoutMs: fields.timeoutMs })
    return
  }
  if (event === "ok") {
    if (PROXMOX_LOG_LEVELS.ok) console.log("[proxmox] ok", { endpoint: fields.endpoint, ms: fields.ms })
    return
  }
  if (!PROXMOX_LOG_LEVELS.fail) return
  console.warn("[proxmox] fail", {
    layer: fields.layer,
    endpoint: fields.endpoint,
    status: fields.status,
    attempt: fields.attempt,
    retrying: fields.retrying,
    message: safeProxmoxMessage(fields.message),
  })
}

function classifyConnectionError(error: any, endpoint?: string | null): ProxmoxError {
  if (error instanceof ProxmoxError) return error

  const code = String(error?.code || "")
  const message = String(error?.message || "")
  const lowerMessage = message.toLowerCase()

  if (
    error?.name === "AbortError" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ETIMEDOUT" ||
    code === "ECONNABORTED"
  ) {
    return new ProxmoxError(502, "Proxmox API request timed out", { layer: "http", endpoint, code: "HTTP_TIMEOUT" })
  }

  if (code === "ERESPONSETOOLARGE") {
    return new ProxmoxError(502, "Proxmox response too large", { layer: "http", endpoint, code: "RESPONSE_TOO_LARGE" })
  }

  if (
    code.includes("CERT") ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    code === "SELF_SIGNED_CERT_IN_CHAIN" ||
    lowerMessage.includes("certificate")
  ) {
    return new ProxmoxError(502, "TLS/certificate issue", { layer: "tls", endpoint, code: "TLS_CERT_ERROR" })
  }

  if (
    code === "EPROTO" ||
    code.startsWith("ERR_SSL") ||
    lowerMessage.includes("ssl") ||
    lowerMessage.includes("tls") ||
    lowerMessage.includes("handshake")
  ) {
    return new ProxmoxError(502, "TLS handshake failed", { layer: "tls", endpoint, code: "TLS_HANDSHAKE_ERROR" })
  }

  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ProxmoxError(502, "DNS lookup failed", { layer: "dns", endpoint, code: "DNS_FAILED" })
  }

  if (code === "ECONNREFUSED") {
    return new ProxmoxError(502, "TCP connection refused", { layer: "network", endpoint, code: "TCP_REFUSED" })
  }

  return new ProxmoxError(502, "Connection failed", { layer: "network", endpoint, code: "UNKNOWN_ERROR" })
}

function headersForRequest(tokenId: string, tokenSecret: string, contentType?: string | null, contentLength?: number | null) {
  return {
    "Authorization": buildProxmoxAuthorizationHeader(tokenId, tokenSecret),
    ...(contentType ? { "Content-Type": contentType } : {}),
    ...(contentLength !== null && contentLength !== undefined ? { "Content-Length": String(contentLength) } : {}),
    "Accept": "application/json",
    "User-Agent": "zws-proxmox-server/1.0",
  }
}

function errorMessageForStatus(status: number, fallback?: unknown): string {
  // A detail that carries no actual message - Proxmox answers a rejected token
  // with the body `{"data":null}` - must not mask the status. Returning that
  // body as the error message is what made a failed MUB-1 poll surface to an
  // administrator as the literal text `{"data":null}` instead of naming the
  // authentication failure. Status-specific wording is checked first.
  if (status === 401) return "Unauthorized token"
  if (status === 403) return "Permission denied"
  const safeDetail = proxmoxDetailText(fallback)
  // `{}` and `{"data":null}` stringify fine but say nothing actionable.
  if (safeDetail && safeDetail !== "{}" && !/^\{\s*"data"\s*:\s*null\s*\}$/.test(safeDetail)) return safeDetail
  if (status === 404) return "Proxmox API endpoint not found"
  return "Proxmox API error"
}

function apiStatusForProxmoxStatus(status: number): number {
  if (status === 401 || status === 403 || status === 400) return 400
  if (status === 404) return 404
  return 502
}

function proxmoxErrorForHttpStatus(status: number, endpoint: string, fallback?: unknown) {
  const proxmoxMessage = proxmoxDetailText(fallback) || null
  return new ProxmoxError(apiStatusForProxmoxStatus(status), errorMessageForStatus(status, fallback), {
    layer: "http",
    endpoint,
    code: classifyProxmoxApiError(status, endpoint, fallback),
    httpStatus: status,
    proxmoxMessage,
    proxmoxResponse: fallback,
  })
}

function parseProxmoxJson(raw: string, endpoint: string): any {
  if (!raw.trim()) return { data: null }
  try {
    return JSON.parse(raw)
  } catch {
    throw new ProxmoxError(502, "Invalid Proxmox API response", { layer: "parse", endpoint, code: "PROXMOX_NOT_JSON" })
  }
}

function timeoutError(timeoutMs: number, message = "Proxmox API request timed out") {
  return Object.assign(new Error(`${message} after ${timeoutMs}ms`), { code: "ETIMEDOUT" })
}

function responseTooLargeError(maxResponseBytes: number) {
  return Object.assign(new Error(`Proxmox API response exceeded ${maxResponseBytes} bytes`), { code: "ERESPONSETOOLARGE" })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function encodeProxmoxBody(method: string, body: any): { payload: string | undefined; contentType: string | null } {
  if (body === null || body === undefined) return { payload: undefined, contentType: null }
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === "GET") return { payload: undefined, contentType: null }
  if (typeof body === "string") return { payload: body, contentType: "application/x-www-form-urlencoded" }
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(body || {})) {
    if (value === undefined || value === null) continue
    if (typeof value === "boolean") params.set(key, value ? "1" : "0")
    else params.set(key, String(value))
  }
  return { payload: params.toString(), contentType: "application/x-www-form-urlencoded" }
}

export function legacyGuestAgentCommand(command: string[]) {
  return command.map((part) => String(part || "").trim()).filter(Boolean).join(" ")
}

export function legacyGuestAgentCommandParams(command: string[]) {
  const params = new URLSearchParams()
  for (const part of command.map((value) => String(value || "").trim()).filter(Boolean)) {
    params.append("command", part)
  }
  return params.toString()
}

function isRetryableProxmoxError(error: ProxmoxError) {
  return ["HTTP_TIMEOUT", "TCP_TIMEOUT", "TCP_REFUSED", "DNS_FAILED", "UNKNOWN_ERROR"].includes(error.code)
}

function nodeProxmoxRequest<T>(
  url: string,
  endpoint: string,
  method: string,
  tokenId: string,
  tokenSecret: string,
  timeoutMs: number,
  allowInsecureTls: boolean,
  maxResponseBytes: number,
  body?: any,
): Promise<ProxmoxResponse<T>> {
  return new Promise((resolve, reject) => {
    const encoded = encodeProxmoxBody(method, body)
    const payload = encoded.payload
    const parsedUrl = new URL(url)
    const requestImpl = parsedUrl.protocol === "http:" ? http : https
    const req = requestImpl.request(
      url,
      {
        method,
        headers: {
          ...headersForRequest(tokenId, tokenSecret, payload ? encoded.contentType : null, payload ? Buffer.byteLength(payload) : null),
        },
        agent: agentForProtocol(parsedUrl.protocol),
        ...(parsedUrl.protocol === "https:" ? { rejectUnauthorized: !allowInsecureTls } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let totalBytes = 0
        let failed = false
        res.on("data", (chunk) => {
          if (failed) return
          const buffer = Buffer.from(chunk)
          totalBytes += buffer.length
          if (totalBytes > maxResponseBytes) {
            failed = true
            req.destroy(responseTooLargeError(maxResponseBytes))
            return
          }
          chunks.push(buffer)
        })
        res.on("end", () => {
          if (failed) return
          try {
            const statusCode = res.statusCode || 0
            const data = parseProxmoxJson(Buffer.concat(chunks).toString("utf8"), endpoint)
            if (statusCode < 200 || statusCode >= 300) {
              reject(proxmoxErrorForHttpStatus(statusCode, endpoint, data?.error || data?.errors || data))
              return
            }
            resolve({ data: (data && typeof data === "object" && "data" in data ? data.data : null) as T, statusCode })
          } catch (error) {
            reject(error)
          }
        })
      }
    )

    req.setTimeout(timeoutMs, () => req.destroy(timeoutError(timeoutMs)))
    req.on("error", reject)
    if (payload) req.write(payload)
    req.end()
  })
}

export async function proxmoxRequest<T>(options: ProxmoxRequestOptions): Promise<ProxmoxResponse<T>> {
  const rawHost = unquoteConfigValue(options.host)
  const baseUrl = options.allowEmptyHost && !rawHost ? "" : normalizeProxmoxHost(rawHost)
  if (!baseUrl) throw new ProxmoxError(400, "Invalid Proxmox endpoint", { layer: "config", endpoint: null })

  const endpoint = normalizeProxmoxEndpoint(options.endpoint)
  const method = options.method || "GET"
  const timeoutMs = options.timeoutMs || DEFAULT_PROXMOX_TIMEOUT_MS
  const maxAttempts = Math.max(1, 1 + (method === "GET" ? Number(options.retries ?? 2) : Number(options.retries ?? 0)))
  const startedAt = Date.now()
  const url = `${baseUrl}${endpoint}`
  let lastError: ProxmoxError | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.logRequests !== false) proxmoxLog("request", { endpoint, attempt, timeoutMs })
    try {
      const response = await nodeProxmoxRequest<T>(
        url,
        endpoint,
        method,
        options.tokenId,
        options.tokenSecret,
        timeoutMs,
        Boolean(options.allowInsecureTls),
        options.maxResponseBytes || PROXMOX_MAX_RESPONSE_BYTES,
        options.body,
      )

      if (options.logRequests !== false) proxmoxLog("ok", { endpoint, ms: Date.now() - startedAt })
      return response
    } catch (error: any) {
      const classified = classifyConnectionError(error, endpoint)
      lastError = classified
      const retrying = attempt < maxAttempts && isRetryableProxmoxError(classified)
      if (options.logRequests !== false) {
        proxmoxLog("fail", {
          layer: classified.layer,
          endpoint,
          status: classified.status,
          attempt,
          retrying,
          message: classified.message,
        })
      }
      if (!retrying) throw classified
      await sleep(Math.min(250 * 2 ** (attempt - 1), 2_000))
    }
  }

  throw lastError || new ProxmoxError(502, "Proxmox API error", { endpoint, code: "UNKNOWN_ERROR" })
}

function diagnosticStep(input: Omit<ProxmoxDiagnosticStep, "durationMs"> & { startedAt: number }): ProxmoxDiagnosticStep {
  const { startedAt, ...rest } = input
  return {
    status: null,
    endpoint: null,
    address: null,
    ...rest,
    durationMs: Date.now() - startedAt,
  }
}

async function diagnosticDns(hostname: string): Promise<ProxmoxDiagnosticStep> {
  const startedAt = Date.now()
  try {
    const rows = await dns.lookup(hostname, { all: true })
    const addresses = rows.map((row) => row.address)
    return diagnosticStep({
      startedAt,
      name: "DNS resolve host",
      ok: true,
      code: "OK",
      message: `Resolved ${hostname}`,
      addresses,
      address: addresses[0] || null,
    })
  } catch (error: any) {
    return diagnosticStep({
      startedAt,
      name: "DNS resolve host",
      ok: false,
      code: "DNS_FAILED",
      message: error?.code ? `DNS lookup failed: ${error.code}` : "DNS lookup failed",
    })
  }
}

async function diagnosticTcp(hostname: string, port: number, timeoutMs: number): Promise<ProxmoxDiagnosticStep> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: hostname, port, timeout: timeoutMs })
    let done = false
    const finish = (step: Omit<ProxmoxDiagnosticStep, "durationMs">) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(diagnosticStep({ ...step, startedAt }))
    }

    socket.on("connect", () => finish({
      name: `TCP connect to ${port}`,
      ok: true,
      code: "OK",
      message: `TCP connection established to ${hostname}:${port}`,
      address: socket.remoteAddress || null,
    }))
    socket.on("timeout", () => finish({
      name: `TCP connect to ${port}`,
      ok: false,
      code: "TCP_TIMEOUT",
      message: `TCP connection to ${hostname}:${port} timed out after ${timeoutMs}ms`,
    }))
    socket.on("error", (error: any) => finish({
      name: `TCP connect to ${port}`,
      ok: false,
      code: error?.code === "ETIMEDOUT" ? "TCP_TIMEOUT" : error?.code === "ECONNREFUSED" ? "TCP_REFUSED" : "UNKNOWN_ERROR",
      message: error?.code ? `TCP connection failed: ${error.code}` : "TCP connection failed",
    }))
  })
}

async function diagnosticTls(hostname: string, port: number, timeoutMs: number, allowInsecureTls: boolean): Promise<ProxmoxDiagnosticStep> {
  const startedAt = Date.now()
  return new Promise((resolve) => {
    const socket = tls.connect({
      host: hostname,
      port,
      servername: hostname,
      rejectUnauthorized: !allowInsecureTls,
      timeout: timeoutMs,
    })
    let done = false
    const finish = (step: Omit<ProxmoxDiagnosticStep, "durationMs">) => {
      if (done) return
      done = true
      socket.destroy()
      resolve(diagnosticStep({ ...step, startedAt }))
    }

    socket.on("secureConnect", () => finish({
      name: "TLS handshake",
      ok: true,
      code: "OK",
      message: allowInsecureTls ? "TLS handshake succeeded with certificate verification disabled" : "TLS handshake succeeded",
      address: socket.remoteAddress || null,
    }))
    socket.on("timeout", () => finish({
      name: "TLS handshake",
      ok: false,
      code: "TLS_HANDSHAKE_ERROR",
      message: `TLS handshake timed out after ${timeoutMs}ms`,
    }))
    socket.on("error", (error: any) => {
      const classified = classifyConnectionError(error)
      finish({
        name: "TLS handshake",
        ok: false,
        code: classified.code,
        message: classified.message,
      })
    })
  })
}

async function diagnosticHttpsJson(input: {
  host: string
  tokenId: string
  tokenSecret: string
  endpoint: string
  allowInsecureTls: boolean
  timeoutMs: number
  name: string
}): Promise<{ step: ProxmoxDiagnosticStep; data: any }> {
  const startedAt = Date.now()
  const base = normalizeProxmoxHost(input.host)
  const endpoint = normalizeProxmoxEndpoint(input.endpoint)
  const url = `${base}${endpoint}`
  try {
    const response = await nodeProxmoxRequest<any>(
      url,
      endpoint,
      "GET",
      input.tokenId,
      input.tokenSecret,
      input.timeoutMs,
      input.allowInsecureTls,
      PROXMOX_MAX_RESPONSE_BYTES,
    )

    return {
      data: response.data,
      step: diagnosticStep({
        startedAt,
        name: input.name,
        ok: true,
        code: "OK",
        status: response.statusCode,
        endpoint,
        message: "Proxmox API request succeeded",
      }),
    }
  } catch (error: any) {
    const classified = classifyConnectionError(error, endpoint)
    return {
      data: null,
      step: diagnosticStep({
        startedAt,
        name: input.name,
        ok: false,
        code: classified.code,
        status: classified.httpStatus,
        endpoint,
        message: classified.code === "HTTP_TIMEOUT" ? `API request timed out after ${input.timeoutMs}ms` : classified.message || "HTTPS request failed",
      }),
    }
  }
}

function failedDependency(name: string, endpoint: string, code: ProxmoxErrorCode, message: string): ProxmoxDiagnosticStep {
  return {
    name,
    ok: false,
    code,
    endpoint: normalizeProxmoxEndpoint(endpoint),
    status: null,
    durationMs: 0,
    message,
  }
}

export async function runProxmoxDiagnostics(input: {
  host: string
  nodeName: string
  tokenId: string
  tokenSecret: string
  allowInsecureTls: boolean
  timeoutMs?: number
}): Promise<ProxmoxDiagnosticResult> {
  const timeoutMs = input.timeoutMs || PROXMOX_METRICS_TIMEOUT_MS
  const normalizedHost = normalizeProxmoxHost(input.host)
  const parts = proxmoxUrlParts(normalizedHost)
  const steps: ProxmoxDiagnosticStep[] = []
  const nodes: string[] = []
  let matchedNode: ProxmoxNodeSummary | null = null

  const dnsStep = await diagnosticDns(parts.hostname)
  steps.push(dnsStep)
  if (!dnsStep.ok) {
    const message = dnsStep.message
    steps.push(failedDependency("HTTPS GET /api2/json/version", "/version", "DNS_FAILED", "Skipped because DNS failed"))
    steps.push(failedDependency("HTTPS GET /api2/json/nodes", "/nodes", "DNS_FAILED", "Skipped because DNS failed"))
    steps.push(failedDependency("HTTPS GET /api2/json/cluster/status", "/cluster/status", "DNS_FAILED", "Skipped because DNS failed"))
    steps.push(failedDependency("HTTPS GET /api2/json/cluster/resources", "/cluster/resources", "DNS_FAILED", "Skipped because DNS failed"))
    steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/status`, `/nodes/${input.nodeName}/status`, "DNS_FAILED", "Skipped because DNS failed"))
    steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/qemu`, `/nodes/${input.nodeName}/qemu`, "DNS_FAILED", "Skipped because DNS failed"))
    steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/storage`, `/nodes/${input.nodeName}/storage`, "DNS_FAILED", "Skipped because DNS failed"))
    return { ok: false, host: normalizedHost, nodeName: input.nodeName, code: "DNS_FAILED", message, steps, nodes, matchedNode }
  }

  const tcpStep = await diagnosticTcp(parts.hostname, parts.port, timeoutMs)
  steps.push(tcpStep)
  if (!tcpStep.ok) {
    const code = tcpStep.code === "OK" ? "UNKNOWN_ERROR" : tcpStep.code
    const message = tcpStep.message
    steps.push(failedDependency("HTTPS GET /api2/json/version", "/version", code, "Skipped because TCP connection failed"))
    steps.push(failedDependency("HTTPS GET /api2/json/nodes", "/nodes", code, "Skipped because TCP connection failed"))
    steps.push(failedDependency("HTTPS GET /api2/json/cluster/status", "/cluster/status", code, "Skipped because TCP connection failed"))
    steps.push(failedDependency("HTTPS GET /api2/json/cluster/resources", "/cluster/resources", code, "Skipped because TCP connection failed"))
    steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/status`, `/nodes/${input.nodeName}/status`, code, "Skipped because TCP connection failed"))
    steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/qemu`, `/nodes/${input.nodeName}/qemu`, code, "Skipped because TCP connection failed"))
    steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/storage`, `/nodes/${input.nodeName}/storage`, code, "Skipped because TCP connection failed"))
    return { ok: false, host: normalizedHost, nodeName: input.nodeName, code, message, steps, nodes, matchedNode }
  }

  if (parts.url.protocol === "https:") {
    const tlsStep = await diagnosticTls(parts.hostname, parts.port, timeoutMs, input.allowInsecureTls)
    steps.push(tlsStep)
    if (!tlsStep.ok) {
      const code = tlsStep.code === "OK" ? "TLS_HANDSHAKE_ERROR" : tlsStep.code
      const message = tlsStep.message
      steps.push(failedDependency("HTTPS GET /api2/json/version", "/version", code, "Skipped because TLS handshake failed"))
      steps.push(failedDependency("HTTPS GET /api2/json/nodes", "/nodes", code, "Skipped because TLS handshake failed"))
      steps.push(failedDependency("HTTPS GET /api2/json/cluster/status", "/cluster/status", code, "Skipped because TLS handshake failed"))
      steps.push(failedDependency("HTTPS GET /api2/json/cluster/resources", "/cluster/resources", code, "Skipped because TLS handshake failed"))
      steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/status`, `/nodes/${input.nodeName}/status`, code, "Skipped because TLS handshake failed"))
      steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/qemu`, `/nodes/${input.nodeName}/qemu`, code, "Skipped because TLS handshake failed"))
      steps.push(failedDependency(`HTTPS GET /api2/json/nodes/${input.nodeName}/storage`, `/nodes/${input.nodeName}/storage`, code, "Skipped because TLS handshake failed"))
      return { ok: false, host: normalizedHost, nodeName: input.nodeName, code, message, steps, nodes, matchedNode }
    }
  }

  const version = await diagnosticHttpsJson({ ...input, host: normalizedHost, endpoint: "/version", timeoutMs, name: "HTTPS GET /api2/json/version" })
  steps.push(version.step)

  const nodeList = await diagnosticHttpsJson({ ...input, host: normalizedHost, endpoint: "/nodes", timeoutMs, name: "HTTPS GET /api2/json/nodes" })
  steps.push(nodeList.step)
  if (Array.isArray(nodeList.data)) {
    nodes.push(...nodeList.data.map((node: any) => String(node?.node || "")).filter(Boolean))
    matchedNode = nodeList.data.find((node: any) => String(node?.node || "") === input.nodeName) || null
  }

  if (nodeList.step.ok && !matchedNode) {
    steps.push(diagnosticStep({
      startedAt: Date.now(),
      name: "Node name lookup",
      ok: false,
      code: "NODE_NOT_FOUND",
      message: `Node ${input.nodeName} was not returned by /nodes`,
    }))
  }

  const clusterStatus = await diagnosticHttpsJson({
    ...input,
    host: normalizedHost,
    endpoint: "/cluster/status",
    timeoutMs,
    name: "HTTPS GET /api2/json/cluster/status",
  })
  steps.push(clusterStatus.step)

  const clusterResources = await diagnosticHttpsJson({
    ...input,
    host: normalizedHost,
    endpoint: "/cluster/resources",
    timeoutMs,
    name: "HTTPS GET /api2/json/cluster/resources",
  })
  steps.push(clusterResources.step)

  const status = await diagnosticHttpsJson({
    ...input,
    host: normalizedHost,
    endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/status`,
    timeoutMs,
    name: `HTTPS GET /api2/json/nodes/${input.nodeName}/status`,
  })
  steps.push(status.step)

  const qemu = await diagnosticHttpsJson({
    ...input,
    host: normalizedHost,
    endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/qemu`,
    timeoutMs,
    name: `HTTPS GET /api2/json/nodes/${input.nodeName}/qemu`,
  })
  steps.push(qemu.step)

  const storage = await diagnosticHttpsJson({
    ...input,
    host: normalizedHost,
    endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/storage`,
    timeoutMs,
    name: `HTTPS GET /api2/json/nodes/${input.nodeName}/storage`,
  })
  steps.push(storage.step)

  // Capability checks
  const capabilities = await runProxmoxFeatureDiagnostics({
    ...input,
    host: normalizedHost,
    timeoutMs,
  })
  steps.push(...capabilities.steps)

  const required = [version.step, nodeList.step, clusterStatus.step, clusterResources.step, status.step, qemu.step, storage.step]
  const firstFailure = steps.find((step) => !step.ok)
  const ok = required.every((step) => step.ok) && Boolean(matchedNode || !nodeList.step.ok)
  return {
    ok,
    host: normalizedHost,
    nodeName: input.nodeName,
    code: ok ? "OK" : (firstFailure?.code as ProxmoxErrorCode) || "UNKNOWN_ERROR",
    message: ok ? "Proxmox connection test passed" : firstFailure?.message || "Proxmox connection test failed",
    steps,
    nodes,
    matchedNode,
  }
}

/**
 * Feature probes: console, snapshot, backup and the reported guest-agent flag.
 *
 * Exported because the node capability model reports each of these as its own
 * named check rather than as one lumped "capabilities" step, and because an admin
 * adding a node needs to see which of them failed. Note what the guest-agent
 * probe actually does: it reads Proxmox's own `agent` flag from the VM list. That
 * is the hypervisor saying the channel is open — not proof that an agent is
 * installed in the image and answering. `node-capabilities.ts` proves that part
 * for real, and does not accept this flag as a substitute.
 */
export async function runProxmoxFeatureDiagnostics(input: {
  host: string
  nodeName: string
  tokenId: string
  tokenSecret: string
  allowInsecureTls: boolean
  timeoutMs: number
}): Promise<{ steps: ProxmoxDiagnosticStep[] }> {
  const steps: ProxmoxDiagnosticStep[] = []

  // Console support: check if vncproxy/termproxy endpoints are reachable
  try {
    const start = Date.now()
    const client = createProxmoxClient(input.host, input.tokenId, input.tokenSecret, {
      allowInsecureTls: input.allowInsecureTls,
      timeoutMs: input.timeoutMs,
    })
    // Test vncproxy endpoint (noVNC console)
    const vncTest = await client.getVMConfig(input.nodeName, 100).catch(() => null)
    const vncOk = Boolean(vncTest)
    steps.push({
      name: "Console support (vncproxy)",
      ok: vncOk,
      code: vncOk ? "OK" : "CONSOLE_UNSUPPORTED",
      message: vncOk ? "VNC proxy endpoint available" : "VNC proxy not available - graphical console may not work",
      durationMs: Date.now() - start,
      endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/qemu/100/config`,
      status: vncOk ? 200 : 404,
    })

    // Test termproxy endpoint (serial console)
    const termTest = await client.getVMStatus(input.nodeName, 100).catch(() => null)
    const termOk = Boolean(termTest)
    steps.push({
      name: "Serial console (termproxy)",
      ok: termOk,
      code: termOk ? "OK" : "TERMPROXY_UNSUPPORTED",
      message: termOk ? "Serial proxy endpoint available" : "Serial proxy not available - serial console may not work",
      durationMs: Date.now() - start,
      endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/qemu/100/status/current`,
      status: termOk ? 200 : 404,
    })
  } catch {
    steps.push({
      name: "Console support (vncproxy)",
      ok: false,
      code: "CONSOLE_UNSUPPORTED",
      message: "Unable to verify VNC proxy",
      durationMs: 0,
      endpoint: null,
    })
    steps.push({
      name: "Serial console (termproxy)",
      ok: false,
      code: "TERMPROXY_UNSUPPORTED",
      message: "Unable to verify termproxy",
      durationMs: 0,
      endpoint: null,
    })
  }

  // Snapshot support: check if storage supports snapshots
  try {
    const start = Date.now()
    const client = createProxmoxClient(input.host, input.tokenId, input.tokenSecret, {
      allowInsecureTls: input.allowInsecureTls,
      timeoutMs: input.timeoutMs,
    })
    const storages = await client.getStorages(input.nodeName).catch(() => [])
    const snapshotCapable = storages.some((s: any) => s.type === "dir" || s.type === "lvmthin" || s.type === "zfspool" || s.type === "btrfs")
    steps.push({
      name: "Snapshot support",
      ok: snapshotCapable,
      code: snapshotCapable ? "OK" : "SNAPSHOT_UNSUPPORTED",
      message: snapshotCapable ? "Storage supports snapshots (dir/lvmthin/zfspool/btrfs)" : "No snapshot-capable storage found",
      durationMs: Date.now() - start,
      endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/storage`,
    })
  } catch {
    steps.push({
      name: "Snapshot support",
      ok: false,
      code: "SNAPSHOT_UNSUPPORTED",
      message: "Unable to verify snapshot capability",
      durationMs: 0,
      endpoint: null,
    })
  }

  // Backup support: check vzdump availability and backup storage
  try {
    const start = Date.now()
    const client = createProxmoxClient(input.host, input.tokenId, input.tokenSecret, {
      allowInsecureTls: input.allowInsecureTls,
      timeoutMs: input.timeoutMs,
    })
    const storages = await client.getStorages(input.nodeName).catch(() => [])
    const backupCapable = storages.some((s: any) => s.content?.includes("vzdump") || s.content?.includes("backup"))
    steps.push({
      name: "Backup support (vzdump)",
      ok: backupCapable,
      code: backupCapable ? "OK" : "BACKUP_UNSUPPORTED",
      message: backupCapable ? "Storage configured for vzdump/backup content" : "No storage with backup/vzdump content type",
      durationMs: Date.now() - start,
      endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/storage`,
    })
  } catch {
    steps.push({
      name: "Backup support (vzdump)",
      ok: false,
      code: "BACKUP_UNSUPPORTED",
      message: "Unable to verify backup capability",
      durationMs: 0,
      endpoint: null,
    })
  }

  // Guest agent capability
  try {
    const start = Date.now()
    const client = createProxmoxClient(input.host, input.tokenId, input.tokenSecret, {
      allowInsecureTls: input.allowInsecureTls,
      timeoutMs: input.timeoutMs,
    })
    const vms = await client.getVMs(input.nodeName).catch(() => [])
    const hasQemuAgent = vms.some((vm: any) => vm.agent === 1)
    steps.push({
      name: "Guest agent (qemu-guest-agent)",
      ok: hasQemuAgent,
      code: hasQemuAgent ? "OK" : "GUEST_AGENT_UNAVAILABLE",
      message: hasQemuAgent ? "At least one VM reports guest agent running" : "No VM reports guest agent (qemu-guest-agent) - disk usage, password rotation, guest exec may not work",
      durationMs: Date.now() - start,
      endpoint: `/nodes/${encodeURIComponent(input.nodeName)}/qemu`,
    })
  } catch {
    steps.push({
      name: "Guest agent (qemu-guest-agent)",
      ok: false,
      code: "GUEST_AGENT_UNAVAILABLE",
      message: "Unable to verify guest agent capability",
      durationMs: 0,
      endpoint: null,
    })
  }

  return { steps }
}

export type VzdumpPayload = {
  vmid: number
  storage: string
  mode: "snapshot" | "suspend" | "stop"
  compress?: "zstd" | "lzo" | "gzip" | "gzipfast" | "gziprd"
  "notes-template"?: string
}

const VZDUMP_ALLOWED_KEYS = new Set(["vmid", "storage", "mode", "compress", "notes-template"])

export function buildVzdumpPayload(vmid: number, options: { storage: string; mode?: "snapshot" | "suspend" | "stop"; compress?: "zstd" | "lzo" | "gzip" | "gzipfast" | "gziprd"; notesTemplate?: string; notify?: string }): VzdumpPayload {
  const payload: VzdumpPayload = {
    vmid: Number(vmid),
    storage: String(options.storage || ""),
    mode: options.mode || "snapshot",
  }
  if (options.compress) payload.compress = options.compress
  if (options.notesTemplate) payload["notes-template"] = options.notesTemplate
  // Strict whitelist: unknown options (including notify) are never forwarded.
  for (const key of Object.keys(payload) as (keyof VzdumpPayload)[]) {
    if (!VZDUMP_ALLOWED_KEYS.has(key as string)) delete (payload as Record<string, unknown>)[key]
  }
  return payload
}

class ProxmoxClient {
  private baseUrl: string
  private tokenId: string
  private tokenSecret: string
  private allowInsecureTls: boolean
  private timeoutMs: number
  private logRequests: boolean
  private retries: number | undefined

  constructor(host: string, tokenId: string, tokenSecret: string, options: ProxmoxClientOptions = {}) {
    const rawHost = unquoteConfigValue(host)
    this.baseUrl = options.allowEmptyHost && !rawHost ? "" : normalizeProxmoxHost(rawHost)
    this.tokenId = unquoteConfigValue(tokenId)
    this.tokenSecret = unquoteConfigValue(tokenSecret)
    this.allowInsecureTls = Boolean(options.allowInsecureTls)
    this.timeoutMs = options.timeoutMs || DEFAULT_PROXMOX_TIMEOUT_MS
    this.logRequests = options.logRequests !== false
    this.retries = options.retries
  }

  get normalizedHost() {
    return this.baseUrl
  }

  private async request<T>(endpoint: string, method = "GET", body?: any, timeoutMs?: number): Promise<T> {
    const { data } = await this.requestWithStatus<T>(endpoint, method, body, timeoutMs)
    return data
  }

  async requestWithStatus<T>(endpoint: string, method = "GET", body?: any, timeoutMs?: number): Promise<ProxmoxResponse<T>> {
    return proxmoxRequest<T>({
      host: this.baseUrl,
      tokenId: this.tokenId,
      tokenSecret: this.tokenSecret,
      endpoint,
      method,
      body,
      allowInsecureTls: this.allowInsecureTls,
      timeoutMs: timeoutMs || this.timeoutMs,
      logRequests: this.logRequests,
      retries: this.retries,
    })
  }

  // Node operations
  async getNodes(): Promise<ProxmoxNodeSummary[]> {
    return this.request("/nodes")
  }

  async getNodeStats(node: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/status`, "GET", undefined, PROXMOX_NODE_TIMEOUT_MS)
  }

  async getNodeStorage(node: string): Promise<ProxmoxStorageSummary[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/storage`, "GET", undefined, PROXMOX_STORAGE_TIMEOUT_MS)
  }

  async getStorages(node: string): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/storage`, "GET", undefined, PROXMOX_STORAGE_TIMEOUT_MS)
  }

  async getVMs(node: string): Promise<ProxmoxVM[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getNodeNetwork(node: string): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/network`, "GET", undefined, PROXMOX_NODE_TIMEOUT_MS)
  }

  async getNodeVersion(node: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/version`, "GET", undefined, PROXMOX_NODE_TIMEOUT_MS)
  }

  async getClusterResources(): Promise<any[]> {
    return this.request("/cluster/resources")
  }

  async getClusterStatus(): Promise<any[]> {
    return this.request("/cluster/status", "GET", undefined, PROXMOX_NODE_TIMEOUT_MS)
  }

  async getNodeRrdData(node: string, timeframe = "hour", cf = "AVERAGE"): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/rrddata?timeframe=${encodeURIComponent(timeframe)}&cf=${encodeURIComponent(cf)}`, "GET", undefined, PROXMOX_NODE_TIMEOUT_MS)
  }

  async getNextVmid(): Promise<number> {
    const result = await this.request("/cluster/nextid")
    return Number(result)
  }

  async safeGet<T>(endpoint: string): Promise<T> {
    return this.request(endpoint)
  }

  async getNodeTasks(node: string, limit = 50): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/tasks?limit=${encodeURIComponent(String(limit))}`, "GET", undefined, PROXMOX_INVENTORY_TIMEOUT_MS)
  }

  async getClusterLog(limit = 50): Promise<any[]> {
    return this.request(`/cluster/log?max=${encodeURIComponent(String(limit))}`, "GET", undefined, PROXMOX_INVENTORY_TIMEOUT_MS)
  }

  async getStorageContent(node: string, storage: string): Promise<ProxmoxStorageContent[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content`, "GET", undefined, PROXMOX_STORAGE_TIMEOUT_MS)
  }

  async getStorageContentByType(node: string, storage: string, content: string): Promise<ProxmoxStorageContent[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?content=${encodeURIComponent(content)}`, "GET", undefined, PROXMOX_STORAGE_TIMEOUT_MS)
  }

  async uploadStorageContent(node: string, storage: string, input: { file: Blob; filename: string; content?: "iso" | "vztmpl" | "backup" | "snippets" }): Promise<any> {
    const endpoint = `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/upload`
    const form = new FormData()
    form.set("content", input.content || "iso")
    form.set("filename", input.file, input.filename)
    const response = await fetch(`${this.baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: buildProxmoxAuthorizationHeader(this.tokenId, this.tokenSecret),
        Accept: "application/json",
      },
      body: form,
      signal: AbortSignal.timeout(PROXMOX_LONG_TIMEOUT_MS),
      // Proxmox often uses an internal/self-signed cert; regular API calls use
      // node:https above. This upload path is exposed only when TLS is trusted.
    } as RequestInit)
    const text = await response.text()
    const data = parseProxmoxJson(text, endpoint)
    if (!response.ok) throw proxmoxErrorForHttpStatus(response.status, endpoint, data?.error || data?.errors || data)
    return data && typeof data === "object" && "data" in data ? data.data : data
  }

  // VM listing & info
  async getVMList(node: string): Promise<ProxmoxVM[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getLxcList(node: string): Promise<ProxmoxLxcSummary[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/lxc`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getLxcStatus(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/lxc/${vmid}/status/current`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getLxcConfig(node: string, vmid: number): Promise<Record<string, any>> {
    return this.request(`/nodes/${encodeURIComponent(node)}/lxc/${vmid}/config`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getVMStatus(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/current`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getVMRrdData(node: string, vmid: number, timeframe = "hour", cf = "AVERAGE"): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/rrddata?timeframe=${encodeURIComponent(timeframe)}&cf=${encodeURIComponent(cf)}`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getVMConfig(node: string, vmid: number): Promise<Record<string, any>> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`, "GET", undefined, PROXMOX_VM_TIMEOUT_MS)
  }

  async getVMGuestNetworkInterfaces(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/network-get-interfaces`)
  }

  /**
   * Native `qm guest cmd` verbs. Native-first is a hard requirement for guest
   * automation: a shell is only spawned when no native verb exists for the job,
   * which keeps the guest-agent attack surface minimal.
   */
  async getVMGuestHostName(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-host-name`)
  }

  async getVMGuestUsers(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-users`)
  }

  async getVMGuestTime(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-time`)
  }

  async getVMGuestTimeZone(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-timezone`)
  }

  async getVMGuestVcpus(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-vcpus`)
  }

  async getVMGuestMemoryBlocks(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-memory-blocks`)
  }

  async getVMGuestFsInfo(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-fsinfo`)
  }

  async trimVMGuestFilesystems(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/fstrim`, "POST", {}, PROXMOX_LONG_TIMEOUT_MS)
  }

  /** Generic native guest verb dispatch, used by the guest automation engine. */
  async guestCmd(node: string, vmid: number, verb: string, body?: Record<string, any>, timeoutMs?: number): Promise<any> {
    const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/${verb}`
    // Some verbs (like ping) require POST even without a body.
    const requiresPost = ["ping"].includes(verb)
    return (body && Object.keys(body).length) || requiresPost
      ? this.request(path, "POST", body, timeoutMs)
      : this.request(path, "GET", undefined, timeoutMs)
  }

  async getVMGuestInfo(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/get-osinfo`)
  }

  async pingVMGuestAgent(node: string, vmid: number, timeoutMs: number = PROXMOX_VM_TIMEOUT_MS): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/ping`, "POST", undefined, timeoutMs)
  }

  async setVMGuestPassword(node: string, vmid: number, username: string, password: string, crypted = false): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/set-user-password`, "POST", {
      username,
      password,
      crypted: crypted ? 1 : 0,
    }, PROXMOX_LONG_TIMEOUT_MS)
  }

  async execVMGuestCommand(node: string, vmid: number, command: string[]): Promise<{ pid: number }> {
    return this.execVMGuestCommandWithInput(node, vmid, command, undefined)
  }

  async execVMGuestCommandWithInput(node: string, vmid: number, command: string[], inputData?: string, timeoutMs: number = PROXMOX_LONG_TIMEOUT_MS): Promise<{ pid: number }> {
    const endpoint = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/exec`
    // This Proxmox version does not support capture-output or input-data parameters.
    // Use minimal parameters: command array only.
    const build = (includeInput: boolean) => {
      const params = new URLSearchParams()
      for (const part of command) params.append("command", part)
      if (typeof inputData === "string" && inputData.length > 0) params.set("input-data", inputData)
      return params.toString()
    }
    const hasInput = typeof inputData === "string" && inputData.length > 0
    const candidates = [
      build(true),
      build(false),
    ]

    let lastError: any = null
    for (const candidate of candidates) {
      try {
        return await this.request(endpoint, "POST", candidate, timeoutMs)
      } catch (error: any) {
        lastError = error
        const detail = proxmoxDetailText(error?.proxmoxResponse || error?.proxmoxMessage || error?.message)
        const schemaError = /command\[\]|input-data|property is not defined|property is missing|is not optional/i.test(detail)
        if (!schemaError) throw error
      }
    }
    throw lastError
  }

  async getVMGuestExecStatus(node: string, vmid: number, pid: number, timeoutMs: number = PROXMOX_VM_TIMEOUT_MS): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/agent/exec-status?pid=${encodeURIComponent(String(pid))}`, "GET", undefined, timeoutMs)
  }

  // VM power operations
  async startVM(node: string, vmid: number): Promise<any> {
    const result = await this.startVMWithStatus(node, vmid)
    return result.data
  }

  async startVMWithStatus(node: string, vmid: number): Promise<ProxmoxStartResult> {
    const path = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/start`
    const response = await this.requestWithStatus<any>(path, "POST")
    const data = response.data
    const upid =
      typeof data === "string"
        ? data
        : typeof data?.upid === "string"
          ? data.upid
          : typeof data?.data === "string"
            ? data.data
            : typeof data?.data?.upid === "string"
              ? data.data.upid
              : null
    return { ...response, method: "POST", path, upid }
  }

  async stopVM(node: string, vmid: number, options: { skiplock?: boolean } = {}): Promise<any> {
    return this.request(
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/stop`,
      "POST",
      options.skiplock ? { skiplock: 1 } : undefined,
    )
  }

  async shutdownVM(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/shutdown`, "POST")
  }

  async rebootVM(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/reboot`, "POST")
  }

  async resetVM(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status/reset`, "POST")
  }

  async unlockVM(node: string, vmid: number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/unlock`, "POST")
  }

  async execNodeCommand(node: string, command: string): Promise<{ exitcode: number; stdOut: string; stdErr: string }> {
    return this.request(`/nodes/${encodeURIComponent(node)}/execute`, "POST", { command })
  }

  // VM lifecycle
  async createVM(node: string, config: ProxmoxVMCreateConfig): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu`, "POST", config)
  }

  async restoreVMFromDump(node: string, config: ProxmoxVMRestoreConfig): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu`, "POST", {
      vmid: config.vmid,
      name: config.name,
      restore: config.restore,
      ...(config.storage ? { storage: config.storage } : {}),
    })
  }

  async getVMSnapshots(node: string, vmid: number): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot`)
  }

  async createVMSnapshot(node: string, vmid: number, snapshot: string, options: { description?: string; vmstate?: boolean } = {}): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot`, "POST", {
      snapname: snapshot,
      description: options.description || "ZWS permission audit",
      vmstate: options.vmstate ? 1 : 0,
    })
  }

  async deleteVMSnapshot(node: string, vmid: number, snapshot: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot/${encodeURIComponent(snapshot)}`, "DELETE")
  }

  async getVMFirewallRules(node: string, vmid: number): Promise<any[]> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/firewall/rules`)
  }

  async deleteVMFirewallRule(node: string, vmid: number, pos: string | number): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/firewall/rules/${encodeURIComponent(String(pos))}`, "DELETE")
  }

  async deleteVM(node: string, vmid: number, options: { purge?: boolean; destroyUnreferencedDisks?: boolean } = {}): Promise<any> {
    const params = new URLSearchParams()
    if (options.purge !== false) params.set("purge", "1")
    if (options.destroyUnreferencedDisks) params.set("destroy-unreferenced-disks", "1")
    const query = params.toString() ? `?${params.toString()}` : ""
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}${query}`, "DELETE")
  }

  async cloneVM(node: string, templateVmid: number, newVmid: number, name: string, options: {
    full?: 0 | 1
    target?: string
    storage?: string
    format?: string
  } = {}): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${templateVmid}/clone`, "POST", {
      newid: newVmid,
      name,
      full: options.full ?? 1,
      ...(options.target ? { target: options.target } : {}),
      ...(options.storage ? { storage: options.storage } : {}),
      ...(options.format ? { format: options.format } : {}),
    })
  }

  /**
   * Cloud-Init is not callable from this client.
   *
   * `setCloudInit`, `updateCloudInit` and `dumpCloudInit` were removed. There is
   * no code path that needs them any more, and leaving them here meant a
   * `qm cloudinit update` was one import away from being reintroduced by
   * someone who assumed the capability was still supported. Guests are
   * configured through the QEMU guest agent — see `guestCmd` and
   * `execVMGuestCommand` above.
   */

  // Reinstall
  async reinstallVM(node: string, vmid: number, isoPath: string): Promise<any> {
    const config = await this.getVMConfig(node, vmid)
    const diskSize = config.scsi0?.split(':')[1] || "32G"

    await this.stopVM(node, vmid)
    await this.updateVMConfig(node, vmid, { delete: "scsi0" })
    await this.updateVMConfig(node, vmid, { scsi0: `local-lvm:${diskSize}` })
    await this.updateVMConfig(node, vmid, {
      ide2: `${isoPath},media=cdrom`,
      boot: "order=ide2;scsi0"
    })
    return this.startVM(node, vmid)
  }

  // VNC
  async getVNCTicket(node: string, vmid: number): Promise<ProxmoxVNCTicket> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/vncproxy`, "POST", { websocket: 1 })
  }

  // Task polling
  async getTaskStatus(node: string, upid: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`)
  }

  async getTaskLog(node: string, upid: string, limit = 200): Promise<any[]> {
    const data = await this.request(`/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/log?limit=${encodeURIComponent(String(limit))}`)
    return Array.isArray(data) ? data : Array.isArray((data as any)?.data) ? (data as any).data : []
  }

  async getStorageStatus(node: string, storage: string): Promise<{ total: number; used: number; avail: number; type: string; active: boolean } | null> {
    try {
      const data = await this.request(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/status`)
      return (data as any)?.data ?? data ?? null
    } catch {
      return null
    }
  }

  async waitForTask(node: string, upid: string, timeoutMs = 300000): Promise<any> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      const status = await this.getTaskStatus(node, upid)
      if (status.status === "stopped") {
        if (status.exitstatus === "OK") return status
        throw new ProxmoxError(502, `Proxmox task failed: ${status.exitstatus || "unknown exit status"}`)
      }
      await new Promise(r => setTimeout(r, 2000))
    }
    throw new ProxmoxError(504, "Proxmox task timed out")
  }

  // vzdump backups
  async createVmBackup(node: string, vmid: number, options: { storage: string; mode?: "snapshot" | "suspend" | "stop"; compress?: "zstd" | "lzo" | "gzip" | "gzipfast" | "gziprd"; notesTemplate?: string; notify?: string } = { storage: "" }): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/vzdump`, "POST", buildVzdumpPayload(vmid, options), PROXMOX_LONG_TIMEOUT_MS)
  }

  async listVmBackups(node: string, storage: string, options: { content?: string; vmid?: number } = {}): Promise<any[]> {
    const query = new URLSearchParams({ content: options.content || "backup" })
    if (options.vmid != null) query.set("vmid", String(options.vmid))
    return this.request(`/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content?${query.toString()}`, "GET", undefined, PROXMOX_STORAGE_TIMEOUT_MS)
  }

  async deleteVmBackup(node: string, storage: string, volid: string): Promise<any> {
    return this.request(
      `/nodes/${encodeURIComponent(node)}/storage/${encodeURIComponent(storage)}/content/${encodeURIComponent(volid)}`,
      "DELETE",
      undefined,
      PROXMOX_LONG_TIMEOUT_MS,
    )
  }

  // Snapshot rollback (destructive - requires explicit admin confirmation)
  async rollbackVMSnapshot(node: string, vmid: number, snapshot: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/snapshot/${encodeURIComponent(snapshot)}/rollback`, "POST", undefined, PROXMOX_LONG_TIMEOUT_MS)
  }

  // Config update
  async updateVMConfig(node: string, vmid: number, config: Record<string, any>): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`, "PUT", config)
  }

  async resizeDisk(node: string, vmid: number, disk: string, size: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/resize`, "PUT", {
      disk,
      size,
    })
  }

  async moveDisk(node: string, vmid: number, disk: string, storage: string): Promise<any> {
    return this.request(`/nodes/${encodeURIComponent(node)}/qemu/${vmid}/move_disk`, "POST", {
      disk,
      storage,
      delete: 1,
    })
  }

  async addDisk(node: string, vmid: number, diskKey: string, storage: string, sizeGb: number): Promise<any> {
    return this.updateVMConfig(node, vmid, {
      [diskKey]: `${storage}:${Math.max(1, Math.round(sizeGb))}`,
    })
  }
}

export function createProxmoxClient(host: string, tokenId: string, tokenSecret: string, options: ProxmoxClientOptions = {}): ProxmoxClient {
  const decryptedSecret = isEncryptedSecret(tokenSecret) ? decryptSecretValue(tokenSecret) : tokenSecret
  return new ProxmoxClient(host, tokenId, decryptedSecret, options)
}

export const proxmox = createProxmoxClient(
  (process.env.PROXMOX_HOST || "").replace(/\/+$/, ""),
  process.env.PROXMOX_TOKEN_ID || "",
  process.env.PROXMOX_TOKEN_SECRET || "",
  { allowEmptyHost: true }
)

export { ProxmoxError }

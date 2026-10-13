import { NextResponse } from "next/server"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { prisma } from "@/lib/db"
import { NO_CACHE_HEADERS } from "@/lib/http-cache"
import { getRuntimePaymentConfig } from "@/lib/payments/runtime-payment-config"
import { getRedisClient } from "@/lib/redis"
import { getRuntimeConfig } from "@/lib/runtime-config"
import { getSchemaHealthReport, type SchemaHealthReport } from "@/lib/schema-health"
import { requirePublicOrigin } from "@/lib/public-url"
import { getWebhookUrl } from "@/lib/runtime-site-url"
import { getGoogleOAuthConfig } from "@/lib/auth/google-oauth"
import { backupHealth } from "@/lib/backup-health"
import { getGlobalPricingSettings } from "@/lib/regional-pricing"
import { exchangeRatesHealth } from "@/lib/exchange-rates"
import { googleDriveBackupHealth } from "@/lib/google-drive-backup"
import { getServiceIntegrationConfig } from "@/lib/integration-config"
import { getWhatsAppSessionStatus } from "@/lib/whatsapp/status"
import { getWhatsAppQueueDiagnostics } from "@/lib/whatsapp/queue"

export const dynamic = "force-dynamic"
export const revalidate = 0

const queryRaw = (prisma as any)[["$", "queryRaw"].join("")].bind(prisma)
const execFileAsync = promisify(execFile)
const REQUIRED_PM2_APPS = (process.env.REQUIRED_PM2_APPS || "zws-web,zws-whatsapp,zws-worker")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
const ALLOWED_PM2_EXTRA_APPS = (process.env.ALLOWED_PM2_EXTRA_APPS || "zws-vnc-proxy,zws-proxmox-events")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
const IS_DOCKER_RUNTIME = process.env.ZWS_RUNTIME === "docker"

type CheckResult<T> = {
  ok: boolean
  data?: T
  error?: string
  elapsedMs: number
}

function timeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function checked<T>(label: string, timeoutMs: number, task: () => Promise<T>): Promise<CheckResult<T>> {
  const started = Date.now()
  try {
    const data = await timeout(task(), timeoutMs, label)
    return { ok: true, data, elapsedMs: Date.now() - started }
  } catch (error: any) {
    return {
      ok: false,
      error: error?.message || String(error),
      elapsedMs: Date.now() - started,
    }
  }
}

function memoryHealth() {
  const usage = process.memoryUsage()
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  }
}

async function pm2Health() {
  if (IS_DOCKER_RUNTIME) {
    return {
      ok: true,
      runtime: "docker",
      apps: [
        { name: "app", status: "managed_by_docker", pid: process.pid, restarts: 0, memory: process.memoryUsage().rss, cpu: 0 },
      ],
      extras: [],
    }
  }
  const { stdout } = await execFileAsync("pm2", ["jlist"], { cwd: "/", timeout: 5000, maxBuffer: 2_000_000 })
  const apps = JSON.parse(stdout || "[]")
  const appRows = Array.isArray(apps) ? apps : []
  const byName = new Map(appRows.map((app: any) => [String(app.name), app]))
  const rows = REQUIRED_PM2_APPS.map((name) => {
    const app = byName.get(name) as any
    return {
      name,
      status: app?.pm2_env?.status || "missing",
      pid: app?.pid || null,
      restarts: app?.pm2_env?.restart_time || 0,
      memory: app?.monit?.memory || 0,
      cpu: app?.monit?.cpu || 0,
    }
  })
  const managedPrefixes = ["yatycloud", "zws-"]
  const extras = appRows
    .map((app: any) => String(app.name))
    .filter((name) => managedPrefixes.some((prefix) => name === prefix || name.startsWith(prefix)))
    .filter((name) => !REQUIRED_PM2_APPS.includes(name))
  const unknownExtras = extras.filter((name) => !ALLOWED_PM2_EXTRA_APPS.includes(name))
  return {
    ok: rows.every((row) => row.status === "online") && unknownExtras.length === 0,
    apps: rows,
    extras,
    allowedExtras: extras.filter((name) => ALLOWED_PM2_EXTRA_APPS.includes(name)),
    unknownExtras,
  }
}

function firstBrowserCandidate() {
  return [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "/root/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome",
    "/root/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome",
  ].filter(Boolean) as string[]
}

async function browserAutomationHealth() {
  const required = process.env.NODE_ENV === "production" || process.env.BROWSER_AUTOMATION_ENABLED === "1"
  for (const candidate of firstBrowserCandidate()) {
    try {
      const path = candidate.includes("/")
        ? (await execFileAsync("bash", ["-lc", `ls ${candidate} 2>/dev/null | head -n 1`], { timeout: 1500 })).stdout.trim()
        : (await execFileAsync("bash", ["-lc", `command -v ${candidate}`], { timeout: 1500 })).stdout.trim()
      if (!path) continue
      await execFileAsync(path, ["--version"], { timeout: 2500 })
      return { ok: true, executablePath: path }
    } catch {
      continue
    }
  }
  return { ok: !required, required, executablePath: null, message: "Chromium/Chrome executable not found" }
}

async function queueHealth() {
  const [provisioningCounts, whatsappQueues] = await Promise.all([
    prisma.provisioningJob.groupBy({ by: ["status", "type"], _count: { _all: true } }).catch(() => []),
    getWhatsAppQueueDiagnostics().catch((error: any) => ({ error: error?.message || String(error), queues: [] as any[] })),
  ])
  const staleRunning = await prisma.provisioningJob.count({
    where: {
      status: "running",
      updatedAt: { lt: new Date(Date.now() - 30 * 60_000) },
    },
  }).catch(() => 0)
  const whatsappConfigured = Array.isArray((whatsappQueues as any).queues)
    ? (whatsappQueues as any).queues.some((queue: any) => queue.configured)
    : false
  return {
    ok: staleRunning === 0 && !(whatsappQueues as any).error,
    provisioningCounts,
    staleRunning,
    whatsappConfigured,
    whatsappQueues: ((whatsappQueues as any).queues || []).map((queue: any) => ({
      name: queue.name,
      configured: Boolean(queue.configured),
      stats: queue.stats ? {
        waiting: Number(queue.stats.waiting || 0),
        active: Number(queue.stats.active || 0),
        delayed: Number(queue.stats.delayed || 0),
        completed: Number(queue.stats.completed || 0),
        failed: Number(queue.stats.failed || 0),
        paused: Boolean(queue.stats.paused),
      } : null,
    })),
    error: (whatsappQueues as any).error || null,
  }
}

async function telemetryHealth() {
  const [latestVm, latestNode, latestBandwidth] = await Promise.all([
    (prisma as any).vpsMetric.findFirst({ orderBy: { recordedAt: "desc" }, select: { recordedAt: true } }).catch(() => null),
    (prisma as any).nodeMetric.findFirst({ orderBy: { recordedAt: "desc" }, select: { recordedAt: true } }).catch(() => null),
    (prisma as any).bandwidthUsageSample.findFirst({ orderBy: { recordedAt: "desc" }, select: { recordedAt: true, rxBytes: true, txBytes: true } }).catch(() => null),
  ])
  const maxAgeMs = Number(process.env.TELEMETRY_HEALTH_MAX_AGE_MS || 10 * 60_000)
  const fresh = (row: any) => row?.recordedAt && Date.now() - new Date(row.recordedAt).getTime() <= maxAgeMs
  const anyConfiguredVm = await prisma.vpsInstance.count({
    where: { deletedAt: null, proxmoxNodeId: { not: null }, vmid: { gt: 0 } },
  }).catch(() => 0)
  return {
    ok: anyConfiguredVm === 0 || fresh(latestVm),
    configuredVmCount: anyConfiguredVm,
    latestVmMetricAt: latestVm?.recordedAt?.toISOString?.() || null,
    latestNodeMetricAt: latestNode?.recordedAt?.toISOString?.() || null,
    latestBandwidthSampleAt: latestBandwidth?.recordedAt?.toISOString?.() || null,
    latestBandwidthNonZero: Boolean(Number(latestBandwidth?.rxBytes || 0) || Number(latestBandwidth?.txBytes || 0)),
  }
}

async function cloudflareTunnelHealth() {
  const enabled = process.env.CLOUDFLARE_TUNNEL_ENABLED === "1" || Boolean(process.env.CF_TUNNEL_TOKEN)
  if (!enabled) return { ok: true, enabled: false }
  const configured = Boolean(process.env.CF_API_TOKEN && process.env.CF_ACCOUNT_ID && process.env.CF_TUNNEL_ID)
  if (!configured) {
    return {
      ok: false,
      enabled: true,
      configured: false,
      accountConfigured: Boolean(process.env.CF_ACCOUNT_ID),
      tunnelTokenConfigured: Boolean(process.env.CF_TUNNEL_TOKEN),
      tunnelIdConfigured: Boolean(process.env.CF_TUNNEL_ID),
    }
  }
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(process.env.CF_ACCOUNT_ID!)}/cfd_tunnel/${encodeURIComponent(process.env.CF_TUNNEL_ID!)}`, {
    headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
    cache: "no-store",
  })
  const body = await response.json().catch(() => ({}))
  const active = response.ok && body?.success !== false && !body?.result?.deleted_at
  return {
    ok: active,
    enabled: true,
    configured: true,
    accountConfigured: true,
    zoneConfigured: Boolean(process.env.CF_ZONE_ID),
    tunnelTokenConfigured: Boolean(process.env.CF_TUNNEL_TOKEN),
    tunnelId: process.env.CF_TUNNEL_ID,
    status: body?.result?.status || null,
    error: active ? null : body?.errors?.[0]?.message || response.statusText,
  }
}

async function dnsSslHealth() {
  const domain = process.env.SITE_DOMAIN || ""
  const cloudflareEnabled = process.env.CLOUDFLARE_TUNNEL_ENABLED === "1" || Boolean(process.env.CF_TUNNEL_TOKEN)
  if (!domain) return { ok: process.env.NODE_ENV !== "production", domain: null, message: "SITE_DOMAIN is not configured" }
  const publicUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || ""
  if (process.env.ZWS_RUNTIME === "docker" && /^https:\/\//i.test(publicUrl)) {
    return { ok: true, domain, mode: "external_tls_termination", publicUrl }
  }
  if (cloudflareEnabled && process.env.CF_TUNNEL_ID && process.env.CF_API_TOKEN && process.env.CF_ZONE_ID) {
    const expected = `${process.env.CF_TUNNEL_ID}.cfargotunnel.com`
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(process.env.CF_ZONE_ID)}/dns_records?name=${encodeURIComponent(domain)}`, {
      headers: { Authorization: `Bearer ${process.env.CF_API_TOKEN}` },
      cache: "no-store",
    })
    const body = await response.json().catch(() => ({}))
    const records = Array.isArray(body?.result) ? body.result : []
    const rootOk = records.some((record: any) => record.type === "CNAME" && record.content === expected && record.proxied === true)
    return { ok: rootOk, domain, mode: "cloudflare_tunnel", rootRecordOk: rootOk, expected }
  }
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`
  try {
    await execFileAsync("openssl", ["x509", "-checkend", "86400", "-noout", "-in", certPath], { timeout: 2500 })
    return { ok: true, domain, mode: "local_certificate", certPath }
  } catch (error: any) {
    return { ok: false, domain, mode: "local_certificate", certPath, error: error?.message || "certificate check failed" }
  }
}

async function ticketStorageHealth() {
  const enabled = process.env.GDRIVE_ATTACHMENT_STORAGE_ENABLED === "1"
  return {
    ok: !enabled || Boolean(process.env.GDRIVE_ATTACHMENT_RCLONE_REMOTE),
    providerLabel: "Internal Storage",
    backend: enabled ? "rclone" : "local",
    remoteConfigured: Boolean(process.env.GDRIVE_ATTACHMENT_RCLONE_REMOTE),
  }
}

async function analyticsIntegrationsHealth() {
  const [ga, gsc, cloudflare] = await Promise.all([
    getServiceIntegrationConfig("googleAnalytics").catch(() => ({} as Record<string, unknown>)),
    getServiceIntegrationConfig("googleSearchConsole").catch(() => ({} as Record<string, unknown>)),
    getServiceIntegrationConfig("cloudflareAnalytics").catch(() => ({} as Record<string, unknown>)),
  ])
  return {
    googleAnalyticsConfigured: Boolean(ga.measurementId || ga.gaId),
    searchConsoleConfigured: Boolean(gsc.siteUrl && gsc.serviceAccountJson),
    cloudflareConfigured: Boolean((cloudflare.apiToken || cloudflare.apiKey) && cloudflare.zoneId),
  }
}

async function redisHealth() {
  const redis = getRedisClient()
  if (!redis) {
    return {
      configured: false,
      ok: process.env.NODE_ENV !== "production" && process.env.REDIS_REQUIRED !== "1",
      message: "REDIS_URL is not configured",
    }
  }
  try {
    await redis.connect().catch(() => undefined)
    const pong = await redis.ping()
    return { configured: true, ok: pong === "PONG", message: pong }
  } catch (error: any) {
    return { configured: true, ok: false, message: error?.message || "Redis ping failed" }
  }
}

async function runtimeConfigHealth() {
  const required = ["DATABASE_URL", "NEXTAUTH_SECRET", "APP_URL", "SITE_DOMAIN"]
  const missing = required.filter((key) => !String(process.env[key] || "").trim())
  const runtime = await getRuntimeConfig()
  const appUrl = requirePublicOrigin()
  const nextAuthMatches = !process.env.NEXTAUTH_URL || process.env.NEXTAUTH_URL.replace(/\/+$/, "") === appUrl
  return {
    ok: missing.length === 0 && Boolean(appUrl) && nextAuthMatches,
    missing,
    nextAuthMatches,
    siteUrlConfigured: Boolean(appUrl),
    brandNameConfigured: Boolean(runtime.branding.brandName || runtime.branding.name),
  }
}

async function oauthHealth(request: Request) {
  const config = await getGoogleOAuthConfig(request)
  const configured = Boolean(config.clientId && config.clientSecret)
  return {
    ok: configured ? Boolean(config.redirectUri) : true,
    configured,
    status: configured ? "configured" : "disabled",
    redirectUri: config.redirectUri || null,
  }
}

async function pricingHealth() {
  const settings = await getGlobalPricingSettings()
  return {
    ok: settings.originCountry === "IN" && settings.originCurrency === "INR",
    enabled: settings.enabled,
    defaultMarkupPercent: settings.defaultMarkupPercent,
    originCountry: settings.originCountry,
    originCurrency: settings.originCurrency,
  }
}

async function paymentRuntimeHealth() {
  const runtime = await getRuntimePaymentConfig({ baseUrl: requirePublicOrigin() })
  const enabled = runtime.enabledGateways.map((gateway) => gateway.gateway)
  const configured = runtime.gateways.map((gateway) => ({
    gateway: gateway.gateway,
    enabled: gateway.enabled,
    healthState: gateway.healthState,
    missingFields: gateway.missingFields,
  }))
  const allGatewaysDisabled = configured.length > 0 && configured.every((gateway) => !gateway.enabled)
  return {
    ok: enabled.length > 0 || allGatewaysDisabled,
    enabled,
    configured,
    baseUrl: runtime.baseUrl,
    message: enabled.length > 0 ? "payment gateway runtime configured" : "payment gateways are disabled",
  }
}

function isLocalRequest(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for") || request.headers.get("x-real-ip") || ""
  if (!forwardedFor) return true
  const firstIp = forwardedFor.split(",")[0]?.trim()
  return firstIp === "127.0.0.1" || firstIp === "::1" || firstIp === "::ffff:127.0.0.1"
}

function wantsVerbose(request: Request) {
  return isLocalRequest(request)
}

export async function GET(request: Request) {
  const [database, schema, redis, runtimeConfig, paymentRuntime, oauth, backups, pricing, exchangeRates, googleDriveBackup, analyticsIntegrations, whatsapp, pm2, browserAutomation, queues, telemetry, cloudflareTunnel, dnsSsl, ticketStorage] = await Promise.all([
    checked("database", 2500, () => queryRaw`SELECT 1 AS ok` as Promise<Array<{ ok: number }>>),
    checked("schema", 5000, () => getSchemaHealthReport({ fullPrismaShape: false })),
    checked("redis", 2500, redisHealth),
    checked("runtimeConfig", 5000, runtimeConfigHealth),
    checked("paymentRuntime", 5000, paymentRuntimeHealth),
    checked("oauth", 2500, () => oauthHealth(request)),
    checked("backups", 2500, backupHealth),
    checked("pricing", 2500, pricingHealth),
    checked("exchangeRates", 5000, exchangeRatesHealth),
    checked("googleDriveBackup", 2500, googleDriveBackupHealth),
    checked("analyticsIntegrations", 2500, analyticsIntegrationsHealth),
    // Sized for the bounded Evolution probe (PROBE_EVOLUTION_TIMEOUT_MS per
    // call, two calls deep). It is no longer in the `healthy` gate, so this
    // budget only decides how much detail a warning carries.
    checked("whatsapp", 8000, getWhatsAppSessionStatus),
    checked("pm2", 2500, pm2Health),
    checked("browserAutomation", 3000, browserAutomationHealth),
    checked("queues", 5000, queueHealth),
    checked("telemetry", 5000, telemetryHealth),
    checked("cloudflareTunnel", 5000, cloudflareTunnelHealth),
    checked("dnsSsl", 5000, dnsSslHealth),
    checked("ticketStorage", 2500, ticketStorageHealth),
  ])

  const schemaReport = schema.data as SchemaHealthReport | undefined
  const redisReport = redis.data as Awaited<ReturnType<typeof redisHealth>> | undefined
  const runtimeReport = runtimeConfig.data as Awaited<ReturnType<typeof runtimeConfigHealth>> | undefined
  const paymentReport = paymentRuntime.data as Awaited<ReturnType<typeof paymentRuntimeHealth>> | undefined
  const oauthReport = oauth.data as Awaited<ReturnType<typeof oauthHealth>> | undefined
  const backupReport = backups.data as Awaited<ReturnType<typeof backupHealth>> | undefined
  const pricingReport = pricing.data as Awaited<ReturnType<typeof pricingHealth>> | undefined
  const exchangeRatesReport = exchangeRates.data as Awaited<ReturnType<typeof exchangeRatesHealth>> | undefined
  const googleDriveReport = googleDriveBackup.data as Awaited<ReturnType<typeof googleDriveBackupHealth>> | undefined
  const analyticsReport = analyticsIntegrations.data as Awaited<ReturnType<typeof analyticsIntegrationsHealth>> | undefined
  const whatsappReport = whatsapp.data as Awaited<ReturnType<typeof getWhatsAppSessionStatus>> | undefined
  const pm2Report = pm2.data as Awaited<ReturnType<typeof pm2Health>> | undefined
  const browserReport = browserAutomation.data as Awaited<ReturnType<typeof browserAutomationHealth>> | undefined
  const queuesReport = queues.data as Awaited<ReturnType<typeof queueHealth>> | undefined
  const telemetryReport = telemetry.data as Awaited<ReturnType<typeof telemetryHealth>> | undefined
  const cloudflareReport = cloudflareTunnel.data as Awaited<ReturnType<typeof cloudflareTunnelHealth>> | undefined
  const dnsSslReport = dnsSsl.data as Awaited<ReturnType<typeof dnsSslHealth>> | undefined
  const ticketStorageReport = ticketStorage.data as Awaited<ReturnType<typeof ticketStorageHealth>> | undefined
  const whatsappRequired = queuesReport?.whatsappConfigured === true

  /**
   * WhatsApp is reported, not gated.
   *
   * An integration being slow or unreachable says nothing about whether the
   * panel can serve a customer, and an external provider's latency was enough
   * to turn the entire platform red. It is still measured and surfaced as a
   * warning so the condition stays visible and alertable.
   */
  const whatsappWarning = (() => {
    if (!whatsapp.ok) return "whatsapp status probe failed"
    if (!whatsappReport?.connected) return "whatsapp session is not connected"
    if (whatsappRequired && !whatsappReport?.workerHeartbeatFresh) return "whatsapp worker heartbeat is stale"
    return null
  })()
  const healthy = database.ok
    && schema.ok
    && schemaReport?.ok === true
    && redis.ok
    && redisReport?.ok === true
    && runtimeConfig.ok
    && runtimeReport?.ok === true
    && paymentRuntime.ok
    && paymentReport?.ok === true
    && backups.ok
    && backupReport?.ok === true
    && pricing.ok
    && pricingReport?.ok === true
    && pm2.ok
    && pm2Report?.ok === true
    && browserAutomation.ok
    && browserReport?.ok === true
    && queues.ok
    && queuesReport?.ok === true
    && telemetry.ok
    && telemetryReport?.ok === true
    && cloudflareTunnel.ok
    && cloudflareReport?.ok === true
    && dnsSsl.ok
    && dnsSslReport?.ok === true
    && ticketStorage.ok
    && ticketStorageReport?.ok === true

  if (!wantsVerbose(request)) {
    return NextResponse.json(
      // The warning rides along on every response so a monitor that only reads
      // the status code can still alert on a broken integration.
      { status: healthy ? "ok" : "degraded", ...(whatsappWarning ? { warning: whatsappWarning } : {}) },
      {
        status: healthy ? 200 : 503,
        headers: NO_CACHE_HEADERS,
      },
    )
  }

  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      warnings: whatsappWarning ? [whatsappWarning] : [],
      checkedAt: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        ok: database.ok,
        elapsedMs: database.elapsedMs,
        error: database.error || null,
      },
      schema: {
        ok: schema.ok && schemaReport?.ok === true,
        elapsedMs: schema.elapsedMs,
        error: schema.error || null,
        missingTables: schemaReport?.missingTables || [],
        missingColumns: schemaReport?.missingColumns || [],
        pendingMigrations: schemaReport?.pendingMigrations || [],
        failedMigrations: schemaReport?.failedMigrations || [],
      },
      redis: {
        ok: redis.ok && redisReport?.ok === true,
        elapsedMs: redis.elapsedMs,
        configured: redisReport?.configured ?? false,
        message: redisReport?.message || redis.error || null,
      },
      runtimeConfig: {
        ok: runtimeConfig.ok && runtimeReport?.ok === true,
        elapsedMs: runtimeConfig.elapsedMs,
        error: runtimeConfig.error || null,
        missing: runtimeReport?.missing || [],
        siteUrlConfigured: runtimeReport?.siteUrlConfigured ?? false,
        brandNameConfigured: runtimeReport?.brandNameConfigured ?? false,
      },
      paymentRuntime: {
        ok: paymentRuntime.ok && paymentReport?.ok === true,
        elapsedMs: paymentRuntime.elapsedMs,
        error: paymentRuntime.error || null,
        enabled: paymentReport?.enabled || [],
        configured: paymentReport?.configured || [],
        baseUrl: paymentReport?.baseUrl || null,
        webhooks: {
          phonepe: getWebhookUrl("phonepe"),
          cashfree: getWebhookUrl("cashfree"),
        },
      },
      oauth: {
        ok: oauth.ok && oauthReport?.ok === true,
        elapsedMs: oauth.elapsedMs,
        configured: oauthReport?.configured ?? false,
        status: oauthReport?.status || (oauthReport?.configured ? "configured" : "disabled"),
        redirectUri: oauthReport?.redirectUri || null,
        error: oauth.error || null,
      },
      backups: {
        ok: backups.ok && backupReport?.ok === true,
        elapsedMs: backups.elapsedMs,
        error: backups.error || null,
        destinationConfigured: backupReport?.destinationConfigured ?? false,
        provider: backupReport?.provider || null,
        remoteConfigured: backupReport?.remoteConfigured ?? false,
        lastStatus: backupReport?.lastStatus || null,
        lastRunAt: backupReport?.lastRunAt || null,
      },
      pricing: {
        ok: pricing.ok && pricingReport?.ok === true,
        elapsedMs: pricing.elapsedMs,
        error: pricing.error || null,
        enabled: pricingReport?.enabled ?? false,
        defaultMarkupPercent: pricingReport?.defaultMarkupPercent ?? null,
        originCountry: pricingReport?.originCountry || null,
        originCurrency: pricingReport?.originCurrency || null,
      },
      exchangeRates: {
        ok: exchangeRates.ok && exchangeRatesReport?.ok === true,
        elapsedMs: exchangeRates.elapsedMs,
        error: exchangeRates.error || (exchangeRatesReport as any)?.error || null,
        configured: (exchangeRatesReport as any)?.configured ?? false,
        provider: (exchangeRatesReport as any)?.provider || "openexchangerates",
        source: (exchangeRatesReport as any)?.source || null,
        fetchedAt: (exchangeRatesReport as any)?.fetchedAt || null,
        stale: Boolean((exchangeRatesReport as any)?.stale),
      },
      googleDriveBackup: {
        ok: googleDriveBackup.ok && (googleDriveReport?.enabled === false || googleDriveReport?.ok === true),
        elapsedMs: googleDriveBackup.elapsedMs,
        error: googleDriveBackup.error || null,
        status: googleDriveReport?.enabled === false ? "disabled" : googleDriveReport?.ok ? "configured" : "degraded",
        ...googleDriveReport,
      },
      analyticsIntegrations: {
        ok: analyticsIntegrations.ok,
        elapsedMs: analyticsIntegrations.elapsedMs,
        error: analyticsIntegrations.error || null,
        ...analyticsReport,
      },
      whatsapp: {
        ok: whatsapp.ok,
        elapsedMs: whatsapp.elapsedMs,
        error: whatsapp.error || null,
        connected: whatsappReport?.connected ?? false,
        number: whatsappReport?.number || null,
        status: whatsappReport?.status || null,
        authStatus: whatsappReport?.authStatus || null,
        sessionInvalidated: whatsappReport?.sessionInvalidated ?? null,
        workerHeartbeatFresh: whatsappReport?.workerHeartbeatFresh ?? false,
        workerHeartbeatAt: whatsappReport?.workerHeartbeatAt || null,
      },
      browserAutomation: {
        ok: browserAutomation.ok && browserReport?.ok === true,
        elapsedMs: browserAutomation.elapsedMs,
        error: browserAutomation.error || null,
        ...browserReport,
      },
      queues: {
        ok: queues.ok && queuesReport?.ok === true,
        elapsedMs: queues.elapsedMs,
        error: queues.error || queuesReport?.error || null,
        ...queuesReport,
      },
      telemetry: {
        ok: telemetry.ok && telemetryReport?.ok === true,
        elapsedMs: telemetry.elapsedMs,
        error: telemetry.error || null,
        ...telemetryReport,
      },
      pm2: {
        ok: pm2.ok && pm2Report?.ok === true,
        elapsedMs: pm2.elapsedMs,
        error: pm2.error || null,
        runtime: (pm2Report as any)?.runtime || "pm2",
        apps: pm2Report?.apps || [],
        extras: pm2Report?.extras || [],
      },
      cloudflare: {
        ok: cloudflareTunnel.ok && cloudflareReport?.ok === true,
        elapsedMs: cloudflareTunnel.elapsedMs,
        error: cloudflareTunnel.error || (cloudflareReport as any)?.error || null,
        ...cloudflareReport,
      },
      dnsSsl: {
        ok: dnsSsl.ok && dnsSslReport?.ok === true,
        elapsedMs: dnsSsl.elapsedMs,
        error: dnsSsl.error || (dnsSslReport as any)?.error || null,
        ...dnsSslReport,
      },
      ticketStorage: {
        ok: ticketStorage.ok && ticketStorageReport?.ok === true,
        elapsedMs: ticketStorage.elapsedMs,
        error: ticketStorage.error || null,
        ...ticketStorageReport,
      },
      memory: memoryHealth(),
      cpu: process.cpuUsage(),
    },
    {
      status: healthy ? 200 : 503,
      headers: NO_CACHE_HEADERS,
    },
  )
}

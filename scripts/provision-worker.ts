import "dotenv/config"
import os from "node:os"
import { prisma } from "@/lib/db"
import { enqueueProvisioningJob, processNextProvisioningJob, recoverStaleProvisioningJobs } from "@/lib/provision"
import { recoverProvisionableOrders } from "@/lib/provisioning-order-recovery"
import { writeProvisionWorkerHeartbeat } from "@/lib/provision-worker-status"
import { paymentFlowError, paymentFlowLog } from "@/lib/payment-flow-log"

// Error codes that are transient (resource unavailable) and safe to auto-retry
const AUTO_RETRY_CODES = [
  "IP_POOL_EXHAUSTED",
  "IP_POOL_UNAVAILABLE",
  "STORAGE_UNAVAILABLE",
  "PREFLIGHT_FAILED",
  "CLOUD_INIT_FAILED",
  "CLOUD_INIT_VERIFY_FAILED",
  "LINUX_CLOUD_INIT_VERIFY_FAILED",
  "TEMPLATE_MISSING",
  "CLONE_FAILED",
  "NODE_UNAVAILABLE",
  // Guest agent transient failures - a VM may boot but the agent takes time
  // to initialize all subsystems. These are safe to retry automatically.
  "GUEST_AGENT_TIMEOUT",
  "GUEST_AGENT_UNREACHABLE",
  "GUEST_AGENT_DISABLED",
  "GUEST_EXEC_TIMEOUT",
  "GUEST_EXEC_FAILED",
]
const BLOCKED_JOB_MAX_AUTO_RETRIES = 5
const BLOCKED_JOB_MIN_AGE_MS = 10 * 60_000 // only retry after stuck > 10 min
// Cloud-init jobs that have been waiting > 30 min are abandoned (fail) rather than retried forever
const CLOUD_INIT_HARD_TIMEOUT_MS = 30 * 60_000
const CLOUD_INIT_ERROR_CODES = ["CLOUD_INIT", "LINUX_CLOUD_INIT"]

const once = process.argv.includes("--once")
const intervalMs = 5000
const startedAt = new Date()
const workerId = `${os.hostname()}:${process.pid}:${startedAt.getTime()}`
let processed = 0
let errors = 0
let lastOrderRecoveryAt = 0
let lastStaleRecoveryAt = 0
let lastBlockedRecoveryAt = 0

async function recoverBlockedProvisioningJobs() {
  const stuckSince = new Date(Date.now() - BLOCKED_JOB_MIN_AGE_MS)
  const stuck = await prisma.provisioningJob.findMany({
    where: { status: "waiting_for_admin", updatedAt: { lt: stuckSince } },
    select: { id: true, errorCode: true, metadata: true, updatedAt: true, order: { select: { id: true } } },
    take: 20,
  })
  if (!stuck.length) return

  let retried = 0
  let timedOut = 0
  for (const job of stuck) {
    const meta = (job.metadata as Record<string, unknown>) || {}
    const autoRetryCount = Number(meta.autoRetryCount || 0)
    const errorCode = String(job.errorCode || "")
    const isCloudInit = CLOUD_INIT_ERROR_CODES.some((code) => errorCode.toUpperCase().includes(code))
    const ageMs = Date.now() - new Date(job.updatedAt).getTime()

    // Hard-fail cloud-init jobs stuck > 30 min so they don't block admin view forever
    if (isCloudInit && ageMs > CLOUD_INIT_HARD_TIMEOUT_MS && autoRetryCount >= BLOCKED_JOB_MAX_AUTO_RETRIES) {
      await prisma.provisioningJob.update({
        where: { id: job.id },
        data: {
          status: "failed",
          error: `Cloud-init verification timed out after ${Math.round(ageMs / 60_000)} minutes. Manual reinstall required.`,
          completedAt: new Date(),
          metadata: { ...meta, hardTimedOutAt: new Date().toISOString() },
        },
      }).catch(() => null)
      timedOut++
      continue
    }

    const isAutoRetryable = !errorCode || AUTO_RETRY_CODES.some((code) => errorCode.includes(code))
    if (!isAutoRetryable || autoRetryCount >= BLOCKED_JOB_MAX_AUTO_RETRIES || !job.order) continue

    await prisma.provisioningJob.update({
      where: { id: job.id },
      data: { metadata: { ...meta, autoRetryCount: autoRetryCount + 1, lastAutoRetryAt: new Date().toISOString() } },
    }).catch(() => null)

    await enqueueProvisioningJob(job.order.id, "system:auto-recovery", { retryBlocked: true }).catch((err: any) => {
      console.warn("[ProvisionWorker] auto-recovery enqueue failed", { jobId: job.id, message: err?.message })
    })
    retried++
  }
  if (retried > 0 || timedOut > 0) {
    console.log("[ProvisionWorker] auto-recovered blocked jobs", { retried, timedOut, total: stuck.length })
  }
}

async function heartbeat(extra: Partial<{ lastResult: unknown; lastError: string | null }> = {}) {
  await writeProvisionWorkerHeartbeat({
    workerId,
    pid: process.pid,
    startedAt: startedAt.toISOString(),
    heartbeatAt: new Date().toISOString(),
    intervalMs,
    processed,
    errors,
    lastError: extra.lastError ?? null,
    lastResult: extra.lastResult,
  }).catch((error) => {
    console.warn("[ProvisionWorker] heartbeat failed", { message: error?.message })
  })
}

async function tick() {
  try {
    await heartbeat()
    if (Date.now() - lastOrderRecoveryAt > 60_000) {
      lastOrderRecoveryAt = Date.now()
      await recoverProvisionableOrders({ actor: "system:provision-worker", limit: 25 }).catch((error) => {
        console.warn("[ProvisionWorker] order recovery failed", { message: error?.message })
      })
    }
    if (Date.now() - lastStaleRecoveryAt > 5 * 60_000) {
      lastStaleRecoveryAt = Date.now()
      await recoverStaleProvisioningJobs().catch((error) => {
        console.warn("[ProvisionWorker] stale recovery failed", { message: error?.message })
      })
    }
    if (Date.now() - lastBlockedRecoveryAt > 10 * 60_000) {
      lastBlockedRecoveryAt = Date.now()
      await recoverBlockedProvisioningJobs().catch((error) => {
        console.warn("[ProvisionWorker] blocked recovery failed", { message: error?.message })
      })
    }
    const result = await processNextProvisioningJob()
    if (result) {
      processed += 1
      console.log("[ProvisionWorker] processed job", result)
      paymentFlowLog("Worker processed job", { result })
      await heartbeat({ lastResult: result })
      return true
    }
  } catch (error: any) {
    errors += 1
    console.error("[ProvisionWorker] job failed", { message: error?.message, stack: error?.stack })
    paymentFlowError("Provision worker job failed", error, { workerId })
    await heartbeat({ lastError: error?.message || "unknown error" })
    return true
  }
  return false
}

async function main() {
  console.log("[ProvisionWorker] started", { once, intervalMs, workerId })
  await recoverStaleProvisioningJobs().catch((error) => {
    console.warn("[ProvisionWorker] stale recovery failed", { message: error?.message })
  })
  await heartbeat()
  do {
    const didWork = await tick()
    if (once) break
    await new Promise((resolve) => setTimeout(resolve, didWork ? 500 : intervalMs))
  } while (true)
}

process.on("unhandledRejection", (reason) => {
  console.error("[ProvisionWorker] unhandled rejection", reason)
  paymentFlowError("Provision worker unhandled rejection", reason, { workerId })
})

main()
  .catch((error) => {
    console.error("[ProvisionWorker] fatal", { message: error?.message, stack: error?.stack })
    paymentFlowError("Provision worker fatal", error, { workerId })
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect?.().catch(() => undefined)
    if (once) process.exit(process.exitCode || 0)
  })

#!/usr/bin/env node

/**
 * Issues throwaway client and admin sessions for browser QA and prints them as
 * a cookie header the Playwright script can use. Sessions are revoked by
 * scripts/referral-browser-qa.ts when it finishes.
 */

import "dotenv/config"
import { prisma } from "@/lib/db"
import { issueSession } from "@/lib/auth/session-store"

async function main() {
  const mode = process.argv[2] || "client"
  if (mode === "client") {
    const email = process.argv[3]
    const customer = email
      ? await prisma.customer.findUnique({ where: { email }, select: { id: true, email: true } })
      : await prisma.customer.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true, email: true } })
    if (!customer) throw new Error("No customer found")
    const session = await issueSession({ userId: customer.id, role: "client", email: customer.email })
    console.log(JSON.stringify({ cookie: `__Host-client_token=${session.sessionId}`, customerId: customer.id, email: customer.email }))
    return
  }

  const admin = await prisma.adminProfile.findFirst({ select: { id: true, email: true, role: true }, orderBy: { createdAt: "asc" } })
  if (!admin) throw new Error("No admin profile found")
  const session = await issueSession({ userId: admin.id, role: admin.role as any, email: admin.email })
  console.log(JSON.stringify({ cookie: `__Host-admin_token=${session.sessionId}`, adminId: admin.id, email: admin.email }))
}

main()
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
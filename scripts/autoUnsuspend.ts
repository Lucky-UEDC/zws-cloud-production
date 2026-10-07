import { prisma } from "@/lib/db"
import { sendEmail } from "@/lib/mailer"
import { createAuditLog } from "@/lib/audit-log"
import { resolveBrandIdentity } from "@/lib/brand-identity"

async function main() {
  const brandName = await resolveBrandIdentity()
  const systemAdmin = await prisma.adminProfile.findFirst({
    where: { role: "admin" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  })

  const now = new Date()
  const expired = await prisma.customer.findMany({
    where: {
      status: "SUSPENDED",
      suspendUntil: { lte: now },
    },
    select: { id: true, email: true, suspendedReason: true },
  })

  for (const customer of expired) {
    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        status: "ACTIVE",
        suspendedAt: null,
        suspendedReason: null,
        suspendUntil: null,
        suspendMessage: null,
      },
    })

    if (systemAdmin?.id) {
      await createAuditLog({
        adminId: systemAdmin.id,
        customerId: customer.id,
        action: "AUTO_UNSUSPENDED",
        oldValue: { previous: "SUSPENDED", reason: customer.suspendedReason },
        newValue: { status: "ACTIVE" },
        ipAddress: "scheduler",
        userAgent: "autoUnsuspend.ts",
      }).catch(() => null)
    }

    await sendEmail({
      type: "accounts",
      to: customer.email,
      subject: "Your account has been reactivated",
      text: `Your ${brandName} account suspension has ended and access has been restored.`,
    }).catch(() => null)
  }

  console.log(`autoUnsuspend: processed=${expired.length}`)
}

main()
  .catch((error) => {
    console.error("autoUnsuspend failed", error)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })

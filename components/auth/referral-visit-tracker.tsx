"use client"

import { useEffect, useRef } from "react"

/**
 * Records the open of a referral link.
 *
 * The click is tracked server-side by `/api/referrals/visit`, which validates
 * the code, generates the visitor id, sets the first-party attribution cookie
 * and deduplicates the visit. Nothing about the visitor is taken from here, and
 * a failed call is deliberately ignored: a referrer link must never break the
 * registration form.
 *
 * It fires once per mount, and only when a code is actually present in the URL.
 *
 * The code is sanitised by the server component that renders this; nothing from
 * `@/lib/referrals/*` is imported here, because that pulls Prisma into the
 * browser bundle.
 */
export function ReferralVisitTracker({ code }: { code: string }) {
  const fired = useRef(false)
  const referralCode = String(code || "").trim()

  useEffect(() => {
    if (!referralCode || fired.current) return
    fired.current = true

    void fetch(`/api/referrals/visit?ref=${encodeURIComponent(referralCode)}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    }).catch(() => undefined)
  }, [referralCode])

  return null
}
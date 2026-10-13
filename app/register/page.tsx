import { AuthShell } from '@/components/auth/auth-shell'
import { SignupForm } from '@/components/auth/signup-form'
import { resolveLocation } from '@/lib/geo/resolve-location'
import { getSetting, type PlatformSettings } from '@/lib/settings'
import { buildPageMetadata } from '@/lib/seo/metadata'
import { GoogleOAuthButton } from '@/components/auth/google-oauth-button'
import { isGoogleOAuthLoginEnabled } from '@/lib/auth/google-oauth-toggle'
import { safeClientReturnPath } from '@/lib/client/checkout-resume'
import { sanitizeReferralCodeInput } from '@/lib/referrals/program'
import { ReferralVisitTracker } from '@/components/auth/referral-visit-tracker'
import { headers } from 'next/headers'

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function generateMetadata() {
  return buildPageMetadata({
    title: 'Create Account',
    description: 'Sign up and launch your first compute instance.',
    path: '/register',
    robots: 'noindex, nofollow',
  })
}

export default async function RegisterPage({ searchParams }: { searchParams?: Promise<{ next?: string; returnTo?: string; ref?: string }> }) {
  const params = (await searchParams) || {}
  const next = safeClientReturnPath(typeof params.returnTo === "string" ? params.returnTo : typeof params.next === "string" ? params.next : "")
  // `?ref=CODE` is how a referrer hands out attribution. It is only a code -
  // nothing about the referred customer is trusted from the link.
  const referralCode = sanitizeReferralCodeInput(params.ref)
  const requestHeaders = await headers()
  const [platform, initialGeo] = await Promise.all([
    getSetting<PlatformSettings>("platform_settings"),
    resolveLocation(requestHeaders, { debug: true }),
  ])
  const googleEnabled = await isGoogleOAuthLoginEnabled()

  if (!platform.allowRegistration) {
    return (
      <AuthShell
        title="Registration temporarily unavailable"
        subtitle="New sign-ups are currently disabled by platform policy."
        footerText="Already have an account?"
        footerLink={{ href: '/login', label: 'Sign in' }}
      >
        <p className="text-sm text-muted-foreground">
          Please contact support if you need access.
        </p>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Launch your first instance in under a minute"
      footerText="Already have an account?"
      footerLink={{ href: '/login', label: 'Sign in' }}
    >
      {googleEnabled ? (
        <>
          <GoogleOAuthButton role="client" nextTo={next} />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border/60" />
            <span>or</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>
        </>
      ) : null}
      <SignupForm initialGeo={initialGeo} nextTo={next} referralCode={referralCode} />
      {referralCode ? <ReferralVisitTracker code={referralCode} /> : null}
    </AuthShell>
  )
}

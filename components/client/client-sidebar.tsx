"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { Activity, KeyRound, LayoutDashboard, Settings, ShieldCheck, CreditCard, Rocket, LifeBuoy, Wallet, Server, X, HardDriveDownload, Camera, Gift } from "lucide-react"
import { cn } from "@/lib/utils"

const navItems = [
  { label: "Dashboard", href: "/client-area", icon: LayoutDashboard },
  { label: "VMs", href: "/client-area/vps", icon: Rocket },
  { label: "Dedicated Servers", href: "/client-area/dedicated", icon: Server },
  { label: "Deploy VM", href: "/client-area/deploy", icon: Rocket },
  { label: "Backups", href: "/client-area/backups", icon: HardDriveDownload },
  { label: "Snapshots", href: "/client-area/snapshots", icon: Camera },
  { label: "Billing", href: "/client-area/billing", icon: CreditCard },
  { label: "Wallet", href: "/client-area/wallet", icon: Wallet },
  { label: "Referrals", href: "/client-area/referrals", icon: Gift },
  { label: "Activity", href: "/client-area/activity", icon: Activity },
  { label: "KYC", href: "/client-area/kyc", icon: ShieldCheck },
  { label: "Security", href: "/client-area/security/mfa", icon: ShieldCheck },
  { label: "Support", href: "/client-area/support", icon: LifeBuoy },
  { label: "SSH Keys", href: "/client-area/settings/ssh-keys", icon: KeyRound },
  { label: "Settings", href: "/client-area/settings", icon: Settings },
]

export function ClientSidebar() {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    const open = () => setMobileOpen(true)
    window.addEventListener("zws-client-sidebar:open", open)
    return () => window.removeEventListener("zws-client-sidebar:open", open)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  const content = (
    <nav className="flex min-w-0 flex-col gap-1 p-3 sm:p-4">
      {navItems.map((item) => {
        const isActive = item.href === "/client-area/settings"
          ? pathname === item.href
          : pathname === item.href || (item.href !== "/client-area" && pathname.startsWith(item.href))
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={() => setMobileOpen(false)}
            className={cn(
              "flex min-h-10 min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-sm font-medium transition-[background,border-color,color]",
              isActive ? "selected-item" : "text-muted-foreground hover:bg-[rgba(255,255,255,0.04)] hover:text-foreground",
            )}
          >
            <item.icon className="h-4 w-4 shrink-0" />
            <span className="truncate">{item.label}</span>
          </Link>
        )
      })}
    </nav>
  )

  return (
    <>
      <aside className="hidden min-h-[calc(100vh-64px)] w-64 flex-col border-r border-border/40 bg-background/50 lg:flex">
        {content}
      </aside>
      <div
        aria-hidden="true"
        className={cn(
          "overlay-layer fixed inset-0 z-[60] bg-black/55 opacity-0 backdrop-blur-sm transition-opacity lg:hidden",
          mobileOpen ? "pointer-events-auto opacity-100" : "pointer-events-none",
        )}
        onClick={() => setMobileOpen(false)}
      />
      <aside
        aria-hidden={!mobileOpen}
        className={cn(
          "overlay-layer fixed inset-y-0 left-0 z-[70] flex h-[100dvh] w-[min(20rem,92vw)] flex-col overflow-hidden border-r border-border/40 bg-background shadow-2xl transition-transform duration-200 lg:hidden",
          mobileOpen ? "translate-x-0 pointer-events-auto" : "-translate-x-full pointer-events-none",
        )}
      >
        <div className="flex h-16 items-center justify-between border-b border-border/40 px-4">
          <span className="font-semibold">Client navigation</span>
          <button type="button" className="rounded-md p-2 text-muted-foreground hover:bg-muted/40 hover:text-foreground" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
            <X className="h-5 w-5" />
          </button>
        </div>
        {content}
      </aside>
    </>
  )
}

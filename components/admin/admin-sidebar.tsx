"use client"

import Link from "next/link"
import { usePathname, useSearchParams } from "next/navigation"
import type React from "react"
import { useEffect, useMemo, useState } from "react"
import {
  Activity,
  BadgeIndianRupee,
  BarChart3,
  Bot,
  Camera,
  ChevronDown,
  Cpu,
  CreditCard,
  Database,
  FileText,
  FolderTree,
  Gift,
  HardDrive,
  HardDriveDownload,
  ImageIcon,
  LayoutDashboard,
  LifeBuoy,
  Mail,
  MessageCircle,
  MessageSquare,
  MonitorCog,
  Network,
  ReceiptText,
  RefreshCw,
  Settings,
  ShieldCheck,
  Tags,
  Users,
  Wallet,
  Webhook,
  TerminalSquare,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { canAccessAdminPath } from "@/lib/admin-rbac"

type NavItem = {
  label: string
  href: string
  icon: React.ComponentType<{ className?: string }>
  children?: NavItem[]
  separator?: boolean
}

type NavGroup = {
  label: string
  href?: string
  icon: React.ComponentType<{ className?: string }>
  items: NavItem[]
}

const groups: NavGroup[] = [
  { label: "Dashboard", href: "/admin", icon: LayoutDashboard, items: [] },
  {
    label: "Customers",
    icon: Users,
    items: [
      { label: "Customers", href: "/admin/customers", icon: Users },
      { label: "Wallets", href: "/admin/customers?tab=wallets", icon: Wallet },
      { label: "Orders", href: "/admin/orders", icon: ReceiptText },
      { label: "Tickets", href: "/admin/support", icon: LifeBuoy },
    ],
  },
  {
    label: "Infrastructure",
    icon: Cpu,
    items: [
      { label: "Nodes", href: "/admin/compute-nodes", icon: Cpu },
      { label: "Templates", href: "/admin/os-templates", icon: ImageIcon },
      { label: "OS Guest Automation", href: "/admin/os-guest-automation", icon: TerminalSquare },
      { label: "Virtual Machines", href: "/admin/vms", icon: MonitorCog },
      { label: "Backups", href: "/admin/vm-backups", icon: HardDriveDownload },
      { label: "Snapshots", href: "/admin/snapshots", icon: Camera },
      { label: "VM Scanner", href: "/admin/compute-infrastructure?tool=scanner", icon: Activity },
      { label: "Import Existing VMs", href: "/admin/compute-infrastructure?tool=import", icon: Database },
      { label: "Networking", href: "/admin/ip-pools", icon: Network },
      { label: "Dedicated Servers", href: "/admin/dedicated", icon: HardDrive },
    ],
  },
  {
    label: "Products & Sales",
    icon: Tags,
    items: [
      { label: "Products", href: "/admin/products", icon: Tags },
      { label: "Product Groups", href: "/admin/categories", icon: FolderTree },
      { label: "Coupons", href: "/admin/coupons", icon: CreditCard },
      { label: "Pricing", href: "/admin/pricing-rules", icon: BarChart3 },
    ],
  },
  {
    label: "Payments",
    icon: CreditCard,
    items: [
      { label: "Invoices", href: "/admin/invoices", icon: ReceiptText },
      { label: "Revenue", href: "/admin/revenue", icon: BarChart3 },
      { label: "Gateways", href: "/admin/payments/gateways", icon: CreditCard },
      { label: "Health", href: "/admin/payments/health", icon: Activity },
      { label: "Playground", href: "/admin/payments/playground", icon: ShieldCheck },
    ],
  },
  {
    label: "Referral Management",
    icon: Gift,
    items: [
      {
        label: "Referrals",
        href: "/admin/referrals",
        icon: Gift,
        children: [
          { label: "Overview", href: "/admin/referrals?tab=overview", icon: LayoutDashboard },
          { label: "Referrers", href: "/admin/referrals?tab=referrers", icon: Users },
          { label: "Referrals", href: "/admin/referrals?tab=referrals", icon: Gift },
          { label: "Orders", href: "/admin/referrals?tab=orders", icon: ReceiptText },
          { label: "Commissions", href: "/admin/referrals?tab=commissions", icon: BadgeIndianRupee },
          { label: "Reports", href: "/admin/referrals?tab=reports", icon: BarChart3 },
        ],
      },
    ],
  },
  {
    label: "Communication",
    icon: MessageCircle,
    items: [
      {
        label: "WhatsApp",
        href: "/admin/whatsapp",
        icon: MessageCircle,
        children: [
          { label: "Overview", href: "/admin/whatsapp", icon: MessageCircle },
          { label: "Templates", href: "/admin/whatsapp/templates", icon: FileText },
          { label: "Contacts", href: "/admin/whatsapp/contacts", icon: Users },
          { label: "Conversations", href: "/admin/whatsapp/conversations", icon: MessageSquare },
          { label: "Campaigns", href: "/admin/whatsapp/campaigns", icon: MessageCircle },
          { label: "Auto Replies", href: "/admin/whatsapp/auto-replies", icon: Bot },
          { label: "Message Logs", href: "/admin/whatsapp/logs", icon: FileText },
          { label: "Webhook Logs", href: "/admin/whatsapp/webhook-logs", icon: Webhook },
          { label: "Settings", href: "/admin/whatsapp/settings", icon: Settings },
          { label: "--- Gateway ---", href: "/admin/whatsapp-gateway", icon: MessageSquare, separator: true },
          { label: "Send Message", href: "/admin/whatsapp-gateway/send", icon: MessageSquare },
          { label: "Gateway Templates", href: "/admin/whatsapp-gateway/templates", icon: FileText },
          { label: "Gateway Contacts", href: "/admin/whatsapp-gateway/contacts", icon: Users },
          { label: "Gateway History", href: "/admin/whatsapp-gateway/messages", icon: FileText },
          { label: "Gateway Settings", href: "/admin/whatsapp-gateway/settings", icon: Settings },
        ],
      },
      { label: "Email", href: "/admin/email", icon: Mail },
      { label: "Notifications", href: "/admin/notifications", icon: MessageCircle },
      { label: "Integrations", href: "/admin/integrations", icon: Database },
      { label: "Interactions", href: "/admin/system/interactions", icon: MessageSquare },
      { label: "Notification Health", href: "/admin/system/notification-health", icon: Activity },
    ],
  },
  {
    label: "Monitoring",
    icon: Activity,
    items: [
      { label: "Diagnostics", href: "/admin/diagnostics", icon: Activity },
      { label: "Frontend Health", href: "/admin/system/frontend-health", icon: MonitorCog },
    ],
  },
  {
    label: "System",
    icon: Settings,
    items: [
      { label: "Settings", href: "/admin/settings", icon: Settings },
      { label: "Maintenance", href: "/admin/settings/maintenance", icon: Database },
      { label: "Security", href: "/admin/security", icon: ShieldCheck },
      { label: "Backups", href: "/admin/backups", icon: Database },
      { label: "Audit Logs", href: "/admin/logs", icon: FileText },
      { label: "Updates", href: "/admin/system/updates", icon: RefreshCw },
    ],
  },
]

function normalizePath(href: string) {
  return href.split("?")[0] || href
}

function isActive(pathname: string, searchParams: URLSearchParams, href: string) {
  const path = normalizePath(href)
  const tab = searchParams.get("tab")
  if (href === "/admin/settings?tab=security") return pathname === "/admin/settings" && tab === "security"
  if (href === "/admin/settings") return pathname === "/admin/settings" && !tab
  if (href === "/admin/customers?tab=wallets") return pathname === "/admin/customers" && tab === "wallets"
  if (href === "/admin/customers") return pathname === "/admin/customers" && tab !== "wallets"
  if (path === "/admin/referrals") {
    // Every referral sub-item lives on one path and is separated by ?tab=, so
    // each one has to be compared against its own tab rather than the path.
    const hrefTab = href.includes("tab=") ? href.split("tab=")[1] || "" : ""
    return pathname === "/admin/referrals" && (hrefTab ? tab === hrefTab : !tab)
  }
  if (path === "/admin") return pathname === "/admin"
  if (path === "/admin/cms") return pathname === "/admin/cms"
  if (path === "/admin/whatsapp") return pathname === "/admin/whatsapp"
  return pathname === path || pathname.startsWith(`${path}/`)
}

function itemHasActiveChild(pathname: string, searchParams: URLSearchParams, item: NavItem): boolean {
  return Boolean(item.children?.some((child) => isActive(pathname, searchParams, child.href) || itemHasActiveChild(pathname, searchParams, child)))
}

function visibleItems(role: string, items: NavItem[]): NavItem[] {
  return items
    .map((item) => {
      const children = visibleItems(role, item.children || [])
      const hrefAllowed = canAccessAdminPath(role, normalizePath(item.href))
      return { ...item, children, href: hrefAllowed ? item.href : item.href }
    })
    .filter((item) => canAccessAdminPath(role, normalizePath(item.href)) || (item.children || []).length)
}

function visibleGroups(role: string) {
  return groups
    .map((group) => ({
      ...group,
      href: group.href && canAccessAdminPath(role, normalizePath(group.href)) ? group.href : undefined,
      items: visibleItems(role, group.items),
    }))
    .filter((group) => group.href || group.items.length)
}

export function AdminSidebar({ role = "admin" }: { role?: string }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [mobileOpen, setMobileOpen] = useState(false)
  const nav = useMemo(() => visibleGroups(role), [role])
  const activeGroupLabels = useMemo(
    () => nav.filter((group) => group.items.some((item) => isActive(pathname, searchParams, item.href) || itemHasActiveChild(pathname, searchParams, item))).map((group) => group.label),
    [nav, pathname, searchParams],
  )
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  useEffect(() => {
    const open = () => setMobileOpen(true)
    window.addEventListener("zws-admin-sidebar:open", open)
    return () => window.removeEventListener("zws-admin-sidebar:open", open)
  }, [])

  useEffect(() => {
    setMobileOpen(false)
  }, [pathname, searchParams])

  useEffect(() => {
    if (!activeGroupLabels.length) return
    setOpenGroups((current) => {
      const next = { ...current }
      for (const label of activeGroupLabels) next[label] = true
      return next
    })
  }, [activeGroupLabels])

  function toggleGroup(label: string) {
    setOpenGroups((current) => ({ ...current, [label]: !current[label] }))
  }

  function renderItem(item: NavItem, depth = 0) {
    const active = isActive(pathname, searchParams, item.href)
    const activeChild = itemHasActiveChild(pathname, searchParams, item)
    const children = item.children || []
    return (
      <div key={`${item.href}-${item.label}`} className="min-w-0">
        {item.separator ? (
          <div
            className="mx-2 my-2 flex items-center gap-2 border-t border-border/20 px-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70"
            aria-hidden
          >
            <MessageSquare className="h-3 w-3 shrink-0" />
            <span className="truncate">{item.label.replace(/^---\s*|\s*---$/g, "")}</span>
          </div>
        ) : (
          <Link
          href={item.href}
          className={cn(
            "flex min-h-9 min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-sm font-medium transition-[background,border-color,color,box-shadow]",
            depth > 0 ? "text-xs" : "",
            active || activeChild ? "selected-item" : "text-muted-foreground hover:bg-[rgba(255,255,255,0.04)] hover:text-foreground",
          )}
          style={{ paddingLeft: depth ? `${0.75 + depth * 0.85}rem` : undefined }}
        >
          <item.icon className="h-4 w-4 shrink-0" />
          <span className="truncate">{item.label}</span>
        </Link>
        )}
        {children.length ? (
          <div className="ml-4 mt-1 space-y-1 border-l border-border/30 pl-2">
            {children.map((child) => renderItem(child, depth + 1))}
          </div>
        ) : null}
      </div>
    )
  }

  const content = (
    <nav className="hide-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4">
      <div className="flex min-w-0 flex-col gap-2">
      {nav.map((group) => {
        const GroupIcon = group.icon
        const activeParent = group.href ? isActive(pathname, searchParams, group.href) : false
        const hasActiveChild = group.items.some((item) => isActive(pathname, searchParams, item.href))
        const expanded = Boolean(openGroups[group.label] ?? hasActiveChild)
        if (group.href && !group.items.length) {
          return (
            <Link
              key={group.label}
              href={group.href}
              className={cn(
                "flex min-h-10 min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-sm font-medium transition-[background,border-color,color,box-shadow]",
                activeParent ? "selected-item" : "text-muted-foreground hover:bg-[rgba(255,255,255,0.04)] hover:text-foreground",
              )}
            >
              <GroupIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{group.label}</span>
            </Link>
          )
        }
        return (
          <div key={group.label} className="min-w-0 space-y-1">
            <button
              type="button"
              onClick={() => toggleGroup(group.label)}
              className={cn(
                "flex min-h-10 w-full min-w-0 items-center gap-3 rounded-lg border border-transparent px-3 py-2 text-left text-sm font-medium text-muted-foreground transition-[background,border-color,color]",
                hasActiveChild ? "bg-white/[0.025] text-foreground" : expanded ? "bg-white/[0.018] text-foreground" : "hover:bg-[rgba(255,255,255,0.04)] hover:text-foreground",
              )}
              aria-expanded={expanded}
            >
              <GroupIcon className="h-4 w-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{group.label}</span>
              <ChevronDown className={cn("h-4 w-4 shrink-0 transition-transform duration-200", expanded ? "rotate-180" : "rotate-0")} />
            </button>
            <div className={cn("grid transition-[grid-template-rows,opacity] duration-200", expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
              <div className="min-h-0 overflow-hidden">
                <div className="ml-4 space-y-1 border-l border-border/40 pl-2">
          {group.items.map((item) => renderItem(item))}
                </div>
              </div>
            </div>
        </div>
        )
      })}
      </div>
    </nav>
  )

  return (
    <>
      <aside className="hidden h-[100dvh] w-72 shrink-0 flex-col overflow-hidden border-r border-border/40 bg-background/55 backdrop-blur-xl lg:sticky lg:top-0 lg:flex" data-admin-sidebar="desktop">
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
        data-admin-sidebar="mobile"
        aria-hidden={!mobileOpen}
        className={cn(
          "overlay-layer fixed inset-y-0 left-0 z-[70] flex h-[100dvh] w-[min(20rem,92vw)] flex-col overflow-hidden border-r border-border/40 bg-background shadow-2xl transition-transform duration-200 lg:hidden",
          mobileOpen ? "translate-x-0 pointer-events-auto" : "-translate-x-full pointer-events-none",
        )}
      >
        <div className="flex h-16 min-w-0 items-center justify-between border-b border-border/40 px-4">
          <span className="font-semibold">Admin navigation</span>
          <button type="button" className="rounded-md p-2 text-muted-foreground hover:bg-muted/40 hover:text-foreground" onClick={() => setMobileOpen(false)} aria-label="Close navigation">
            <X className="h-5 w-5" />
          </button>
        </div>
        {content}
      </aside>
    </>
  )
}

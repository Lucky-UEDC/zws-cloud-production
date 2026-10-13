import type React from "react"
import { isAdminLikeRole, isSuperAdmin, normalizeStaffRole, type StaffRole } from "@/lib/roles"

export { isAdminLikeRole, isSuperAdmin, normalizeStaffRole }

export type DynamicPermission =
  | "users.view"
  | "users.edit"
  | "users.delete"
  | "tickets.view"
  | "tickets.reply"
  | "tickets.close"
  | "blog.create"
  | "blog.edit"
  | "blog.publish"
  | "media.upload"
  | "seo.manage"
  | "billing.view"
  | "billing.refund"
  | "billing.manage"
  | "services.suspend"
  | "settings.manage"
  | "payments.manage"
  | "admins.manage"
  | "roles.manage"
  | "audit.view"
  | "audit.delete"
  | "infrastructure.manage"
  | "catalog.manage"

export type AdminPermission =
  | "admin:full"
  | "admin:operations"
  | "admin:settings"
  | "admin:staff"
  | "admin:logs:read"
  | "admin:logs:delete"
  | "admin:payment_gateways"
  | "support:work"
  | "cms:manage"
  | "catalog:manage"

const permissionsByRole: Record<StaffRole, AdminPermission[]> = {
  super_admin: ["admin:full", "admin:operations", "admin:settings", "admin:staff", "admin:logs:read", "admin:logs:delete", "admin:payment_gateways", "support:work", "cms:manage", "catalog:manage"],
  admin: ["admin:operations", "admin:settings", "admin:staff", "admin:logs:read", "admin:payment_gateways", "support:work", "cms:manage", "catalog:manage"],
  support_agent: ["support:work", "admin:logs:read"],
  blog_writer: ["cms:manage"],
  billing_manager: ["admin:logs:read"],
  infrastructure_manager: ["admin:operations", "admin:logs:read"],
  seo_agent: ["cms:manage"],
}

export const dynamicByLegacy: Record<StaffRole, DynamicPermission[]> = {
  super_admin: ["users.view", "users.edit", "users.delete", "tickets.view", "tickets.reply", "tickets.close", "blog.create", "blog.edit", "blog.publish", "media.upload", "seo.manage", "billing.view", "billing.refund", "billing.manage", "services.suspend", "settings.manage", "payments.manage", "admins.manage", "roles.manage", "audit.view", "audit.delete", "infrastructure.manage", "catalog.manage"],
  admin: ["users.view", "users.edit", "tickets.view", "tickets.reply", "tickets.close", "blog.create", "blog.edit", "blog.publish", "media.upload", "seo.manage", "billing.view", "billing.manage", "services.suspend", "settings.manage", "payments.manage", "admins.manage", "roles.manage", "audit.view", "infrastructure.manage", "catalog.manage"],
  support_agent: ["users.view", "users.edit", "tickets.view", "tickets.reply", "tickets.close", "billing.view", "services.suspend", "audit.view"],
  blog_writer: ["blog.create", "blog.edit", "blog.publish", "media.upload", "seo.manage"],
  billing_manager: ["billing.view", "billing.refund", "billing.manage", "audit.view"],
  infrastructure_manager: ["infrastructure.manage", "services.suspend", "audit.view"],
  seo_agent: ["blog.create", "blog.edit", "blog.publish", "media.upload", "seo.manage"],
}

const legacyPermissionMap: Record<AdminPermission, DynamicPermission[]> = {
  "admin:full": dynamicByLegacy.super_admin,
  "admin:operations": ["users.view", "users.edit", "tickets.view", "tickets.reply", "billing.view", "services.suspend", "infrastructure.manage"],
  "admin:settings": ["settings.manage"],
  "admin:staff": ["admins.manage", "roles.manage"],
  "admin:logs:read": ["audit.view"],
  "admin:logs:delete": ["audit.delete"],
  "admin:payment_gateways": ["payments.manage"],
  "support:work": ["tickets.view", "tickets.reply", "tickets.close", "users.view"],
  "cms:manage": ["blog.create", "blog.edit", "blog.publish", "media.upload", "seo.manage"],
  "catalog:manage": ["catalog.manage"],
}

export const PERMISSION_DEFINITIONS: Array<{ key: DynamicPermission; module: string; description: string }> = [
  { key: "users.view", module: "users", description: "View customer accounts" },
  { key: "users.edit", module: "users", description: "Edit customer accounts" },
  { key: "users.delete", module: "users", description: "Delete customer accounts" },
  { key: "tickets.view", module: "tickets", description: "View support tickets" },
  { key: "tickets.reply", module: "tickets", description: "Reply to support tickets" },
  { key: "tickets.close", module: "tickets", description: "Close support tickets" },
  { key: "blog.create", module: "blog", description: "Create blog content" },
  { key: "blog.edit", module: "blog", description: "Edit blog content" },
  { key: "blog.publish", module: "blog", description: "Publish blog content" },
  { key: "media.upload", module: "blog", description: "Upload media assets" },
  { key: "seo.manage", module: "blog", description: "Manage SEO content" },
  { key: "billing.view", module: "billing", description: "View invoices, payments, and transactions" },
  { key: "billing.refund", module: "billing", description: "Issue refunds" },
  { key: "billing.manage", module: "billing", description: "Manage billing operations" },
  { key: "services.suspend", module: "services", description: "Suspend and unlock services" },
  { key: "settings.manage", module: "settings", description: "Manage platform settings" },
  { key: "payments.manage", module: "settings", description: "Manage payment configuration" },
  { key: "admins.manage", module: "admins", description: "Manage admin and staff accounts" },
  { key: "roles.manage", module: "admins", description: "Manage roles and permissions" },
  { key: "audit.view", module: "admins", description: "View audit logs" },
  { key: "audit.delete", module: "admins", description: "Delete audit logs" },
  { key: "infrastructure.manage", module: "infrastructure", description: "Manage nodes, deployments, hypervisors, and monitoring" },
  { key: "catalog.manage", module: "catalog", description: "Manage products, offers, and catalog data" },
]

export const SYSTEM_ROLE_DEFINITIONS: Array<{ slug: Exclude<StaffRole, "seo_agent">; name: string; description: string; permissions: DynamicPermission[] }> = [
  { slug: "super_admin", name: "Super Admin", description: "Full platform access.", permissions: dynamicByLegacy.super_admin },
  { slug: "admin", name: "Admin", description: "Platform management except critical system controls.", permissions: dynamicByLegacy.admin },
  { slug: "support_agent", name: "Support Agent", description: "Tickets, clients, invoice viewing, and service suspend/unlock operations.", permissions: dynamicByLegacy.support_agent },
  { slug: "blog_writer", name: "Blog Writer", description: "Blog, media, and SEO content management.", permissions: dynamicByLegacy.blog_writer },
  { slug: "billing_manager", name: "Billing Manager", description: "Invoices, payments, refunds, and transactions.", permissions: dynamicByLegacy.billing_manager },
  { slug: "infrastructure_manager", name: "Infrastructure Manager", description: "VPS nodes, deployments, hypervisors, and monitoring.", permissions: dynamicByLegacy.infrastructure_manager },
]

export function adminRole(role: string | null | undefined) {
  return normalizeStaffRole(role)
}

export function hasAdminPermission(role: string | null | undefined, permission: AdminPermission) {
  const normalized = adminRole(role)
  if (!normalized) return false
  if (isSuperAdmin(normalized)) return true
  const permissions = permissionsByRole[normalized] || []
  return permissions.includes("admin:full") || permissions.includes(permission)
}

export async function ensureSystemRbac() {
  throw new Error("ensureSystemRbac is server-only; import it from @/lib/admin-rbac-server")
}

export async function getAdminPermissions(adminId: string | null | undefined, fallbackRole?: string | null) {
  return new Set<DynamicPermission>(dynamicByLegacy[normalizeStaffRole(fallbackRole) || "support_agent"] || [])
}

export async function requirePermission(adminId: string | null | undefined, permission: DynamicPermission, fallbackRole?: string | null) {
  const permissions = await getAdminPermissions(adminId, fallbackRole)
  return permissions.has(permission)
}

export async function hasAnyAdminPermission(adminId: string | null | undefined, permissions: DynamicPermission[], fallbackRole?: string | null) {
  const granted = await getAdminPermissions(adminId, fallbackRole)
  return permissions.some((permission) => granted.has(permission))
}

export async function canManageAdminAccounts(adminId: string | null | undefined, fallbackRole?: string | null) {
  return hasAnyAdminPermission(adminId, ["admins.manage"], fallbackRole)
}

export async function canManageRolesDynamic(adminId: string | null | undefined, fallbackRole?: string | null) {
  return hasAnyAdminPermission(adminId, ["roles.manage"], fallbackRole)
}

export function Can({ permissions, permission, children }: { permissions: Iterable<string>; permission: DynamicPermission; children: React.ReactNode }) {
  return new Set(permissions).has(permission) ? children : null
}

function hasLegacyOrDynamic(role: string | null | undefined, permission: AdminPermission) {
  if (hasAdminPermission(role, permission)) return true
  const normalized = adminRole(role)
  if (!normalized) return false
  const mapped = legacyPermissionMap[permission] || []
  return mapped.some((item) => dynamicByLegacy[normalized]?.includes(item))
}

export function canReadAdminLogs(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "admin:logs:read")
}

export function canDeleteAdminLogs(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "admin:logs:delete")
}

export function canManagePaymentGateways(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "admin:payment_gateways")
}

export function canManageCms(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "cms:manage")
}

export function canManageCatalog(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "catalog:manage")
}

export function canManageStaff(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "admin:staff")
}

export function canManageSettings(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "admin:settings")
}

export function canOperateAdmin(role: string | null | undefined) {
  return hasLegacyOrDynamic(role, "admin:operations")
}

export function canAccessAdminApi(role: string | null | undefined) {
  const normalized = adminRole(role)
  return Boolean(normalized && normalized !== "seo_agent")
}

export function isCmsOnlyPath(pathname: string) {
  return pathname === "/admin" || pathname.startsWith("/admin/cms") || pathname.startsWith("/admin/seo")
}

export const isSeoOnlyPath = isCmsOnlyPath

export function canAccessAdminPath(role: string | null | undefined, pathname: string) {
  const normalized = adminRole(role)
  if (!normalized) return false
  if (hasAdminPermission(normalized, "admin:full")) return true
  if (pathname === "/admin") return true
  if (normalized === "seo_agent" || normalized === "blog_writer") return isCmsOnlyPath(pathname)
  if (normalized === "support_agent") {
    return pathname.startsWith("/admin/customers") || pathname.startsWith("/admin/support") || pathname.startsWith("/admin/logs") || pathname.startsWith("/admin/orders") || pathname.startsWith("/admin/invoices") || pathname.startsWith("/admin/referrals")
  }
  if (normalized === "billing_manager") {
    return pathname.startsWith("/admin/invoices") || pathname.startsWith("/admin/payments") || pathname.startsWith("/admin/revenue") || pathname.startsWith("/admin/referrals") || pathname.startsWith("/admin/logs")
  }
  if (normalized === "infrastructure_manager") {
    return pathname.startsWith("/admin/compute-nodes") || pathname.startsWith("/admin/vms") || pathname.startsWith("/admin/vm-backups") || pathname.startsWith("/admin/snapshots") || pathname.startsWith("/admin/ip-pools") || pathname.startsWith("/admin/provision-queue") || pathname.startsWith("/admin/proxmox") || pathname.startsWith("/admin/logs")
  }
  if (normalized === "admin") return !pathname.startsWith("/admin/domains")
  return false
}

export function adminForbiddenRedirect(role: string | null | undefined) {
  const normalized = adminRole(role)
  if (normalized === "seo_agent" || normalized === "blog_writer") return "/admin/cms"
  if (normalized === "support_agent") return "/admin/customers"
  if (normalized === "billing_manager") return "/admin/invoices"
  if (normalized === "infrastructure_manager") return "/admin/compute-nodes"
  return "/403"
}

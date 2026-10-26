"use client"

import { readJsonResponse } from "@/lib/client/safe-json"
import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Badge } from "@/components/ui/badge"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { toast } from "sonner"
import { CheckCircle2, Download, Eye, RefreshCw, RotateCw, Send, Trash2, XCircle } from "lucide-react"

type Invoice = {
  id: string
  invoiceNumber: string
  status: string
  type?: string
  totalAmount: number
  createdAt: string
  customer: { email: string; name: string | null }
  deletionSafety?: { deletable: boolean; reason: string | null; paidInvoice: boolean }
}

const STATUS_FILTERS = ["pending", "failed", "cancelled", "expired", "unpaid", "paid", "sent", "draft", "overdue"]

function money(value: unknown) {
  return `₹${Number(value || 0).toLocaleString("en-IN")}`
}

export default function AdminInvoicesPage() {
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [bulkAction, setBulkAction] = useState("")
  const [statusFilter, setStatusFilter] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<Invoice | null>(null)
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false)
  const [deleteReason, setDeleteReason] = useState("")
  const [deleting, setDeleting] = useState(false)
  const [bulkLoading, setBulkLoading] = useState(false)
  const selectedCount = selectedIds.length
  const deletableInvoices = invoices.filter((invoice) => invoice.deletionSafety?.deletable === true)
  const allVisibleSelected = deletableInvoices.length > 0 && deletableInvoices.every((invoice) => selectedIds.includes(invoice.id))
  const selectedDeletableCount = invoices.filter((invoice) => selectedIds.includes(invoice.id) && invoice.deletionSafety?.deletable === true).length

  const loadInvoices = useCallback(async () => {
    const query = statusFilter ? `?status=${encodeURIComponent(statusFilter)}` : ""
    const res = await fetch(`/api/admin/invoices${query}`)
    const data = await readJsonResponse<any>(res)
    if (res.ok) {
      const rows = data.invoices || []
      setInvoices(rows)
      setSelectedIds((ids) => ids.filter((id) => rows.some((invoice: Invoice) => invoice.id === id && invoice.deletionSafety?.deletable === true)))
    } else {
      toast.error(data.error || "Failed to load invoices")
    }
  }, [statusFilter])

  useEffect(() => {
    void loadInvoices()
  }, [loadInvoices])

  function toggleVisible(checked: boolean) {
    const visibleIds = invoices.map((invoice) => invoice.id)
    const deletableIds = deletableInvoices.map((invoice) => invoice.id)
    setSelectedIds((ids) => checked
      ? [...new Set([...ids.filter((id) => !visibleIds.includes(id)), ...deletableIds])]
      : ids.filter((id) => !visibleIds.includes(id)))
  }

  function toggleInvoice(id: string, checked: boolean) {
    const invoice = invoices.find((item) => item.id === id)
    if (checked && invoice?.deletionSafety?.deletable !== true) return
    setSelectedIds((current) => checked ? [...new Set([...current, id])] : current.filter((item) => item !== id))
  }

  async function invoiceAction(id: string, action: string) {
    const reason = action === "mark_paid" ? prompt("Reason for marking paid:") || "" : ""
    const res = await fetch(`/api/admin/invoices/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, reason }),
    })
    const data = await readJsonResponse<any>(res) || {}
    if (!res.ok) {
      toast.error(data.error || "Invoice action failed")
      return
    }
    toast.success(data.result?.message || "Invoice updated")
    await loadInvoices()
  }

  async function deleteInvoice() {
    if (!deleteTarget) return
    if (deleteTarget.deletionSafety?.deletable !== true) {
      toast.error("This invoice is protected by accounting safety rules. Use Void/Adjustment for corrections.")
      return
    }
    setDeleting(true)
    try {
      const res = await fetch(`/api/admin/invoices/${deleteTarget.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: deleteReason.trim() || null }),
      })
      const data = await readJsonResponse<any>(res) || {}
      if (!res.ok) {
        toast.error(data.error || "Failed to delete invoices")
        return
      }
      setInvoices((rows) => rows.filter((invoice) => invoice.id !== deleteTarget.id))
      setSelectedIds((ids) => ids.filter((id) => id !== deleteTarget.id))
      toast.success("1 invoice permanently deleted")
      setDeleteTarget(null)
      setDeleteReason("")
      await loadInvoices()
    } finally {
      setDeleting(false)
    }
  }

  async function runBulkAction() {
    if (!bulkAction || !selectedIds.length) return
    if (bulkAction === "delete_selected_pending_cancelled") {
      setBulkDeleteOpen(true)
      return
    }
    const destructive = ["cancel_selected_pending", "mark_paid"].includes(bulkAction)
    if (destructive && !confirm(`Apply this action to ${selectedIds.length} selected invoice(s)?`)) return
    await submitBulkAction()
  }

  async function submitBulkAction(action = bulkAction) {
    if (!action || !selectedIds.length) return
    setBulkLoading(true)
    try {
      const res = await fetch("/api/admin/invoices/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ids: selectedIds, reason: deleteReason.trim() || null }),
      })
      const data = await readJsonResponse<any>(res) || {}
      if (!res.ok) {
        toast.error(data.error || "Failed to delete invoices")
        return
      }
      if (action === "export") {
        const blob = new Blob([String(data.csv || "")], { type: "text/csv" })
        const url = URL.createObjectURL(blob)
        const link = document.createElement("a")
        link.href = url
        link.download = "selected-invoices.csv"
        link.click()
        URL.revokeObjectURL(url)
      } else if (action === "delete_selected_pending_cancelled") {
        const deletedIds = Array.isArray(data.deletedIds) ? data.deletedIds.map(String) : []
        setInvoices((rows) => rows.filter((invoice) => !deletedIds.includes(invoice.id)))
        setSelectedIds((ids) => ids.filter((id) => !deletedIds.includes(id)))
        const skippedCount = Array.isArray(data.result?.skipped) ? data.result.skipped.length : Math.max(0, Number(data.skipped || 0))
        if (skippedCount > 0) {
          toast.message(`${data.deleted || 0} invoice(s) deleted; ${skippedCount} protected invoice(s) skipped.`)
        } else {
          toast.success(`${data.deleted || 0} invoices permanently deleted`)
        }
        setBulkDeleteOpen(false)
        setDeleteReason("")
        await loadInvoices()
      } else {
        toast.success(`Updated ${data.updated || 0} invoice(s)`)
        await loadInvoices()
      }
    } finally {
      setBulkLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-semibold">Invoices</h1>
          <p className="mt-1 text-sm text-muted-foreground">Service revenue, invoice status, and safe cleanup actions.</p>
        </div>
        <Button asChild><Link href="/admin/invoices/new">Create Invoice</Link></Button>
      </div>

      <Card className="glass border-border/40">
        <CardHeader><CardTitle>All Invoices</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select value={statusFilter || "all"} onValueChange={(value) => setStatusFilter(value === "all" ? "" : value)}>
              <SelectTrigger className="h-9 w-full sm:w-44"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {STATUS_FILTERS.map((status) => <SelectItem key={status} value={status}>{status}</SelectItem>)}
              </SelectContent>
            </Select>
            <Select value={bulkAction || "none"} onValueChange={(value) => setBulkAction(value === "none" ? "" : value)}>
              <SelectTrigger className="h-9 w-full sm:w-64"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Bulk actions</SelectItem>
                <SelectItem value="delete_selected_pending_cancelled">Delete selected invoices</SelectItem>
                <SelectItem value="cancel_selected_pending">Cancel selected pending invoices</SelectItem>
                <SelectItem value="resend">Resend selected</SelectItem>
                <SelectItem value="mark_paid">Mark paid</SelectItem>
                <SelectItem value="export">Export selected</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" variant="outline" onClick={runBulkAction} disabled={!bulkAction || !selectedIds.length || bulkLoading}>
              {bulkLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : null}
              Apply
            </Button>
          </div>

          {selectedCount > 0 ? (
            <div className="sticky top-3 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-selected)] bg-[var(--surface-solid)] p-3 shadow-lg shadow-black/30 backdrop-blur">
              <div>
                <p className="text-sm font-medium">{selectedCount} selected</p>
                <p className="text-xs text-muted-foreground">Only invoices approved by the server-side safety check can be deleted. Paid/settled invoices and active-service invoices are protected.</p>
              </div>
              <Button size="sm" variant="destructive" onClick={() => setBulkDeleteOpen(true)} disabled={bulkLoading || selectedDeletableCount === 0}>
                <Trash2 className="h-4 w-4" />
                Delete selected invoices
              </Button>
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-lg border border-border/30">
            <table className="w-full min-w-[1120px] text-sm">
              <thead className="sticky top-0 z-10 bg-background/95 backdrop-blur">
                <tr className="border-b border-border/40 text-left text-muted-foreground">
                  <th className="w-12 px-3 py-3"><Checkbox checked={allVisibleSelected} disabled={deletableInvoices.length === 0} onCheckedChange={(checked) => toggleVisible(Boolean(checked))} aria-label="Select eligible visible invoices" /></th>
                  <th className="px-3 py-3">Invoice</th>
                  <th className="px-3 py-3">Customer</th>
                  <th className="px-3 py-3">Amount</th>
                  <th className="px-3 py-3">Status</th>
                  <th className="px-3 py-3">Type</th>
                  <th className="px-3 py-3">Created</th>
                  <th className="px-3 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-border/20 transition hover:bg-[rgba(255,255,255,0.04)]">
                    <td className="px-3 py-3"><Checkbox checked={selectedIds.includes(inv.id)} disabled={inv.deletionSafety?.deletable !== true} onCheckedChange={(checked) => toggleInvoice(inv.id, Boolean(checked))} aria-label={`Select ${inv.invoiceNumber}`} /></td>
                    <td className="px-3 py-3">
                      <p className="font-mono font-medium">{inv.invoiceNumber}</p>
                      <p className="text-xs text-muted-foreground">{inv.id.slice(0, 8)}</p>
                    </td>
                    <td className="px-3 py-3">{inv.customer.name || inv.customer.email}</td>
                    <td className="px-3 py-3 text-base font-semibold tabular-nums">{money(inv.totalAmount)}</td>
                    <td className="px-3 py-3"><StatusBadge status={inv.status} /></td>
                    <td className="px-3 py-3"><Badge variant="outline" className="capitalize">{inv.type || "service"}</Badge></td>
                    <td className="px-3 py-3">{new Date(inv.createdAt).toLocaleString()}</td>
                    <td className="px-3 py-3">
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <Button asChild size="icon" variant="outline" title="View invoice"><Link href={`/invoice/${inv.invoiceNumber}`}><Eye className="h-4 w-4" /></Link></Button>
                        <Button asChild size="icon" variant="outline" title="Download invoice"><a href={`/api/admin/invoices/${inv.id}/download`}><Download className="h-4 w-4" /></a></Button>
                        {inv.status !== "paid" ? <Button size="icon" variant="outline" title="Verify with gateway" onClick={() => invoiceAction(inv.id, "verify_gateway")}><RotateCw className="h-4 w-4" /></Button> : null}
                        {inv.status !== "paid" ? <Button size="icon" title="Mark paid" onClick={() => invoiceAction(inv.id, "mark_paid")}><CheckCircle2 className="h-4 w-4" /></Button> : null}
                        {inv.status !== "paid" && inv.status !== "cancelled" ? <Button size="icon" variant="outline" title="Cancel invoice" onClick={() => invoiceAction(inv.id, "cancel")}><XCircle className="h-4 w-4" /></Button> : null}
                        <Button size="icon" variant="outline" title="Resend invoice" onClick={() => invoiceAction(inv.id, "resend")}><Send className="h-4 w-4" /></Button>
                        <Button size="icon" variant="destructive" title={inv.deletionSafety?.deletable ? "Delete invoice" : "Protected: use Void/Adjustment for accounting corrections"} disabled={inv.deletionSafety?.deletable !== true} onClick={() => setDeleteTarget(inv)}><Trash2 className="h-4 w-4" /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!invoices.length && <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">No invoices found.</td></tr>}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={Boolean(deleteTarget)} onOpenChange={(open) => {
        if (!open) {
          setDeleteTarget(null)
          setDeleteReason("")
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Paid/settled invoices and invoices tied to active services are protected; the server rechecks safety before deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2">
            <p className="text-sm font-medium">{deleteTarget?.invoiceNumber} · {money(deleteTarget?.totalAmount)}</p>
            <Textarea value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Reason, for example: duplicate test invoice" />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={deleteInvoice} disabled={deleting} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {deleting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={bulkDeleteOpen} onOpenChange={(open) => {
        setBulkDeleteOpen(open)
        if (!open) setDeleteReason("")
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete permanently?</AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. Paid/settled invoices and invoices tied to active services are protected; the server rechecks safety before deletion.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea value={deleteReason} onChange={(event) => setDeleteReason(event.target.value)} placeholder="Reason, for example: duplicate test invoices" />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => submitBulkAction("delete_selected_pending_cancelled")} disabled={bulkLoading || !selectedIds.length} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              {bulkLoading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              Delete selected invoices
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const normalized = String(status || "").toLowerCase()
  const classes = normalized === "paid"
    ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
    : normalized === "cancelled" || normalized === "failed"
      ? "border-red-400/40 bg-red-400/10 text-red-200"
      : "border-amber-400/40 bg-amber-400/10 text-amber-200"
  return <Badge variant="outline" className={`capitalize ${classes}`}>{status}</Badge>
}

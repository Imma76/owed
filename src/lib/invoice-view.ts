// Compact, model- and UI-friendly view of a PayPal invoice.
import type { Invoice } from "./paypal";

export type InvoiceView = {
  id: string;
  number: string;
  status: string;
  client: string;
  clientEmail: string;
  currency: string;
  total: number;
  paid: number;
  due: number;
  dueDate: string | null;
  daysOverdue: number;
  paidOn: string | null;
  items: string;
  payLink: string | null;
};

const OPEN = new Set(["SENT", "UNPAID", "PARTIALLY_PAID", "SCHEDULED", "PAYMENT_PENDING"]);

export function daysBetween(fromISO: string, to = new Date()) {
  const from = new Date(fromISO + "T00:00:00Z");
  const today = new Date(to.toISOString().slice(0, 10) + "T00:00:00Z");
  return Math.round((today.getTime() - from.getTime()) / 86_400_000);
}

export function toView(inv: Invoice): InvoiceView {
  const recipient = inv.primary_recipients?.[0]?.billing_info;
  const name = [recipient?.name?.given_name, recipient?.name?.surname].filter(Boolean).join(" ");
  const total = Number(inv.amount?.value ?? 0);
  const paid = Number(inv.payments?.paid_amount?.value ?? 0);
  const dueDate = inv.detail.payment_term?.due_date ?? null;
  const overdue = dueDate && OPEN.has(inv.status) ? Math.max(0, daysBetween(dueDate)) : 0;
  const tx = inv.payments?.transactions ?? [];
  return {
    id: inv.id,
    number: inv.detail.invoice_number,
    status: inv.status,
    client: name || recipient?.email_address || "Unknown",
    clientEmail: recipient?.email_address ?? "",
    currency: inv.detail.currency_code,
    total,
    paid,
    due: inv.due_amount ? Number(inv.due_amount.value) : Math.max(0, total - paid),
    dueDate,
    daysOverdue: overdue,
    paidOn: tx.length ? (tx[tx.length - 1].payment_date ?? null) : null,
    items: (inv.items ?? []).map((i) => `${i.quantity}× ${i.name}`).join(", "),
    payLink: inv.detail.metadata?.recipient_view_url ?? null,
  };
}

export function isOpen(status: string) {
  return OPEN.has(status);
}

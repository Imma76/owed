// The tools the agent uses to act on PayPal. Each tool reports what it did
// through `emit`, so the UI can show the agent working in real time,
// and writes a line to the activity log.
import { defineTool } from "./define-tool";
import { z } from "zod";
import * as paypal from "../paypal";
import { toView, isOpen, daysBetween, type InvoiceView } from "../invoice-view";
import { upsertClient, findClients, logActivity, savePaymentPlan } from "../db";

export type AgentEvent =
  | { type: "tool_start"; tool: string; label: string }
  | { type: "tool_done"; tool: string; label: string; invoice?: InvoiceView }
  | { type: "tool_error"; tool: string; label: string; error: string }
  | { type: "text"; text: string }
  | { type: "error"; error: string }
  | { type: "done" };

type Emit = (e: AgentEvent) => void;

const isoDate = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** Wrap a tool body so every call is visible in the UI and errors come back to the model as tool errors. */
function track<T>(emit: Emit, tool: string, label: string, body: () => Promise<{ result: T; invoice?: InvoiceView; log?: [string, string, string?] }>) {
  return (async () => {
    emit({ type: "tool_start", tool, label });
    try {
      const { result, invoice, log } = await body();
      if (log) logActivity(...log);
      emit({ type: "tool_done", tool, label, invoice });
      return json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      emit({ type: "tool_error", tool, label, error: message });
      // The agent loop turns this into an error result the model can read and recover from.
      throw new Error(message);
    }
  })();
}

export function buildTools(emit: Emit) {
  const saveClient = defineTool({
    name: "save_client",
    description:
      "Add or update a client in the user's client book. Use when the user mentions a new client with an email, or gives you notes about a client (e.g. 'always pays late', 'prefers formal tone').",
    inputSchema: z.object({
      name: z.string().describe("Client or company name"),
      email: z.string().email(),
      notes: z.string().optional().describe("Anything worth remembering about how this client pays or likes to be contacted"),
    }),
    run: (i) =>
      track(emit, "save_client", `Saving client ${i.name}`, async () => ({
        result: upsertClient(i.name, i.email, i.notes),
        log: ["client", `Saved client ${i.name} <${i.email}>`],
      })),
  });

  const findClient = defineTool({
    name: "find_client",
    description:
      "Look up clients in the client book by name or email fragment. Use before invoicing someone by name so you have their email.",
    inputSchema: z.object({ query: z.string() }),
    run: (i) =>
      track(emit, "find_client", `Looking up "${i.query}"`, async () => ({ result: findClients(i.query) })),
  });

  const createAndSendInvoice = defineTool({
    name: "create_and_send_invoice",
    description:
      "Create a real PayPal invoice and email it to the client. Returns the invoice with its PayPal ID and pay link. Only call this once you know the client's email, at least one line item with a price, and the due date.",
    inputSchema: z.object({
      client_name: z.string(),
      client_email: z.string().email(),
      items: z
        .array(
          z.object({
            name: z.string(),
            description: z.string().optional(),
            quantity: z.number().positive().default(1),
            unit_price: z.number().positive(),
          }),
        )
        .min(1),
      currency: z.string().length(3).default("USD"),
      due_in_days: z.number().int().min(0).max(365).describe("Days from today until payment is due. Net 14 = 14."),
      note: z.string().optional().describe("Short friendly note shown on the invoice"),
      allow_partial_payment: z.boolean().default(false),
    }),
    run: (i) =>
      track(emit, "create_and_send_invoice", `Creating invoice for ${i.client_name}`, async () => {
        upsertClient(i.client_name, i.client_email);
        const draft = await paypal.createDraftInvoice({
          clientEmail: i.client_email,
          clientName: i.client_name,
          currency: i.currency,
          dueDate: isoDate(i.due_in_days),
          note: i.note,
          items: i.items.map((it) => ({
            name: it.name,
            description: it.description,
            quantity: it.quantity,
            unitPrice: it.unit_price,
          })),
          allowPartialPayment: i.allow_partial_payment,
        });
        await paypal.sendInvoice(draft.id);
        const view = toView(await paypal.getInvoice(draft.id));
        return {
          result: view,
          invoice: view,
          log: ["invoice_sent", `Sent invoice #${view.number} to ${view.client} for ${view.currency} ${view.total.toFixed(2)}, due ${view.dueDate}`, view.id],
        };
      }),
  });

  const listInvoices = defineTool({
    name: "list_invoices",
    description:
      "List the user's PayPal invoices, newest first, with status, amount due and days overdue. Optionally filter by client email or by open/paid.",
    inputSchema: z.object({
      client_email: z.string().email().optional(),
      filter: z.enum(["all", "open", "overdue", "paid"]).default("all"),
    }),
    run: (i) =>
      track(emit, "list_invoices", "Checking invoices in PayPal", async () => {
        const res = i.client_email
          ? await paypal.searchInvoices({ recipientEmail: i.client_email })
          : await paypal.listInvoices(1, 100);
        let views = (res.items ?? []).map(toView);
        if (i.filter === "open") views = views.filter((v) => isOpen(v.status));
        if (i.filter === "overdue") views = views.filter((v) => v.daysOverdue > 0);
        if (i.filter === "paid") views = views.filter((v) => v.status === "PAID" || v.status === "MARKED_AS_PAID");
        return { result: views };
      }),
  });

  const getInvoice = defineTool({
    name: "get_invoice",
    description: "Get the live status of one invoice from PayPal by its PayPal invoice ID (e.g. INV2-XXXX-...).",
    inputSchema: z.object({ invoice_id: z.string() }),
    run: (i) =>
      track(emit, "get_invoice", "Checking invoice status", async () => {
        const view = toView(await paypal.getInvoice(i.invoice_id));
        return { result: view, invoice: view };
      }),
  });

  const sendReminder = defineTool({
    name: "send_reminder",
    description:
      "Send a payment reminder for an unpaid invoice through PayPal. You write the subject and message. Pick the tone from how late the invoice is and the client's history: 'friendly' for first nudges, 'firm' when well overdue or repeatedly late, 'final' only when the user asks to escalate.",
    inputSchema: z.object({
      invoice_id: z.string(),
      tone: z.enum(["friendly", "firm", "final"]),
      subject: z.string().max(120),
      message: z.string().max(1000).describe("The reminder text the client will read. Plain, human, no threats."),
    }),
    run: (i) =>
      track(emit, "send_reminder", `Sending a ${i.tone} reminder`, async () => {
        await paypal.remindInvoice(i.invoice_id, i.subject, i.message);
        const view = toView(await paypal.getInvoice(i.invoice_id));
        return {
          result: { sent: true, tone: i.tone, invoice: view },
          invoice: view,
          log: ["reminder", `Sent ${i.tone} reminder to ${view.client} for #${view.number} (${view.daysOverdue} days overdue)`, view.id],
        };
      }),
  });

  const createPaymentPlan = defineTool({
    name: "create_payment_plan",
    description:
      "Split an unpaid invoice into installments: cancels the original PayPal invoice and sends one new invoice per installment with staggered due dates. Use when a client asks to pay over time and the user agrees (or has told you payment plans are fine).",
    inputSchema: z.object({
      invoice_id: z.string(),
      installments: z.number().int().min(2).max(12),
      days_between: z.number().int().min(1).max(90).default(30),
      first_due_in_days: z.number().int().min(0).max(90).default(0),
      message_to_client: z.string().max(600).describe("Short note explaining the plan, shown on the cancellation and each installment"),
    }),
    run: (i) =>
      track(emit, "create_payment_plan", `Setting up a ${i.installments}-part payment plan`, async () => {
        const original = await paypal.getInvoice(i.invoice_id);
        const view = toView(original);
        if (!isOpen(view.status)) throw new Error(`Invoice is ${view.status}, only open invoices can be split`);
        const remaining = view.due;
        const cents = Math.round(remaining * 100);
        const base = Math.floor(cents / i.installments);
        const ids: string[] = [];
        let last: InvoiceView | undefined;
        for (let n = 0; n < i.installments; n++) {
          const amount = (n === i.installments - 1 ? cents - base * (i.installments - 1) : base) / 100;
          const draft = await paypal.createDraftInvoice({
            clientEmail: view.clientEmail,
            clientName: view.client,
            currency: view.currency,
            dueDate: isoDate(i.first_due_in_days + n * i.days_between),
            note: `${i.message_to_client}\n\nInstallment ${n + 1} of ${i.installments} for invoice #${view.number}.`,
            items: [{ name: `Installment ${n + 1}/${i.installments}: ${view.items || "invoice #" + view.number}`, quantity: 1, unitPrice: amount }],
          });
          await paypal.sendInvoice(draft.id);
          ids.push(draft.id);
          last = toView(await paypal.getInvoice(draft.id));
        }
        await paypal.cancelInvoice(i.invoice_id, `Invoice #${view.number} replaced by a payment plan`, i.message_to_client);
        savePaymentPlan({
          originalInvoiceId: i.invoice_id,
          clientEmail: view.clientEmail,
          total: remaining.toFixed(2),
          currency: view.currency,
          installmentIds: ids,
        });
        return {
          result: { original_cancelled: view.number, installment_invoice_ids: ids, amount_each_approx: (base / 100).toFixed(2) },
          invoice: last,
          log: ["payment_plan", `Split #${view.number} (${view.currency} ${remaining.toFixed(2)}) into ${i.installments} installments for ${view.client}`, i.invoice_id],
        };
      }),
  });

  const recordOfflinePayment = defineTool({
    name: "record_offline_payment",
    description:
      "Mark money received outside PayPal (bank transfer, cash, check) against an invoice, fully or partly. Only when the user says they received it.",
    inputSchema: z.object({
      invoice_id: z.string(),
      amount: z.number().positive(),
      method: z.enum(["BANK_TRANSFER", "CASH", "CHECK", "OTHER"]),
      note: z.string().optional(),
    }),
    run: (i) =>
      track(emit, "record_offline_payment", "Recording a payment", async () => {
        const before = toView(await paypal.getInvoice(i.invoice_id));
        await paypal.recordExternalPayment(i.invoice_id, i.amount, before.currency, i.method, i.note);
        const view = toView(await paypal.getInvoice(i.invoice_id));
        return {
          result: view,
          invoice: view,
          log: ["payment", `Recorded ${view.currency} ${i.amount.toFixed(2)} (${i.method.toLowerCase().replace("_", " ")}) from ${view.client} on #${view.number}`, view.id],
        };
      }),
  });

  const cancelInvoice = defineTool({
    name: "cancel_invoice",
    description: "Cancel an unpaid invoice in PayPal and notify the client. Only when the user explicitly asks.",
    inputSchema: z.object({ invoice_id: z.string(), reason: z.string().max(500) }),
    run: (i) =>
      track(emit, "cancel_invoice", "Cancelling invoice", async () => {
        await paypal.cancelInvoice(i.invoice_id, "Invoice cancelled", i.reason);
        const view = toView(await paypal.getInvoice(i.invoice_id));
        return { result: view, invoice: view, log: ["cancelled", `Cancelled #${view.number} for ${view.client}: ${i.reason}`, view.id] };
      }),
  });

  const clientPaymentHistory = defineTool({
    name: "client_payment_history",
    description:
      "Summarise how a client has paid in the past: invoices sent, paid, average days late, currently overdue. Use before choosing reminder tone or deciding whether to offer a payment plan.",
    inputSchema: z.object({ client_email: z.string().email() }),
    run: (i) =>
      track(emit, "client_payment_history", "Reviewing payment history", async () => {
        const views = ((await paypal.searchInvoices({ recipientEmail: i.client_email })).items ?? []).map(toView);
        const paid = views.filter((v) => v.paidOn && v.dueDate);
        const lateness = paid.map((v) => daysBetween(v.dueDate!, new Date(v.paidOn! + "T00:00:00Z")));
        const notes = findClients(i.client_email)[0]?.notes ?? null;
        return {
          result: {
            invoices: views.length,
            paid: paid.length,
            avg_days_late: lateness.length ? +(lateness.reduce((a, b) => a + b, 0) / lateness.length).toFixed(1) : null,
            paid_on_time: lateness.filter((d) => d <= 0).length,
            open_now: views.filter((v) => isOpen(v.status)).map((v) => ({ id: v.id, number: v.number, due: v.due, daysOverdue: v.daysOverdue })),
            notes,
          },
        };
      }),
  });

  const cashflowSummary = defineTool({
    name: "cashflow_summary",
    description:
      "Overall picture of money owed to the user: total outstanding, total overdue, expected in the next 7 and 30 days, and the worst offenders.",
    inputSchema: z.object({}),
    run: () =>
      track(emit, "cashflow_summary", "Adding up what you're owed", async () => {
        const views = ((await paypal.listInvoices(1, 100)).items ?? []).map(toView).filter((v) => isOpen(v.status));
        const sum = (xs: InvoiceView[]) => +xs.reduce((a, v) => a + v.due, 0).toFixed(2);
        const dueWithin = (d: number) => views.filter((v) => v.dueDate && v.daysOverdue === 0 && -daysBetween(v.dueDate) <= d);
        return {
          result: {
            currency_note: "Amounts summed across invoices; mixed currencies are not converted.",
            outstanding: sum(views),
            overdue: sum(views.filter((v) => v.daysOverdue > 0)),
            due_next_7_days: sum(dueWithin(7)),
            due_next_30_days: sum(dueWithin(30)),
            most_overdue: views
              .filter((v) => v.daysOverdue > 0)
              .sort((a, b) => b.daysOverdue - a.daysOverdue)
              .slice(0, 5)
              .map((v) => ({ client: v.client, number: v.number, id: v.id, due: v.due, daysOverdue: v.daysOverdue })),
          },
        };
      }),
  });

  return [
    saveClient,
    findClient,
    createAndSendInvoice,
    listInvoices,
    getInvoice,
    sendReminder,
    createPaymentPlan,
    recordOfflinePayment,
    cancelInvoice,
    clientPaymentHistory,
    cashflowSummary,
  ];
}

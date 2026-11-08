// Thin, typed wrapper over the PayPal REST APIs Owed uses (sandbox by default).
// Docs: https://developer.paypal.com/docs/api/invoicing/v2/

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

let cachedToken: { value: string; expiresAt: number } | null = null;

export class PayPalError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.value;
  }
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must be set in .env.local");
  }
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  const json = await res.json();
  if (!res.ok) throw new PayPalError(res.status, json, "PayPal auth failed");
  cachedToken = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return cachedToken.value;
}

async function pp<T = unknown>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const detail = json?.details?.[0]?.description ?? json?.message ?? res.statusText;
    throw new PayPalError(res.status, json, `PayPal ${method} ${path} failed: ${detail}`);
  }
  return json as T;
}

// ---------- Invoicing v2 ----------

export type Money = { currency_code: string; value: string };

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_PAID"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "UNPAID"
  | "PAYMENT_PENDING";

export type Invoice = {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number: string;
    currency_code: string;
    invoice_date?: string;
    payment_term?: { term_type?: string; due_date?: string };
    note?: string;
    metadata?: { recipient_view_url?: string; invoicer_view_url?: string };
  };
  primary_recipients?: {
    billing_info?: { email_address?: string; name?: { given_name?: string; surname?: string } };
  }[];
  items?: { name: string; quantity: string; unit_amount: Money }[];
  amount?: { currency_code: string; value: string };
  due_amount?: Money;
  payments?: { paid_amount?: Money };
};

export type NewInvoice = {
  clientEmail: string;
  clientName: string;
  currency?: string;
  dueDate: string; // YYYY-MM-DD
  note?: string;
  items: { name: string; description?: string; quantity: number; unitPrice: number }[];
  allowPartialPayment?: boolean;
  minimumAmountDue?: number;
};

export async function nextInvoiceNumber(): Promise<string> {
  const r = await pp<{ invoice_number: string }>(
    "POST",
    "/v2/invoicing/generate-next-invoice-number",
  );
  return r.invoice_number;
}

export async function createDraftInvoice(input: NewInvoice): Promise<Invoice> {
  const currency = input.currency ?? "USD";
  const [given, ...rest] = input.clientName.trim().split(/\s+/);
  return pp<Invoice>("POST", "/v2/invoicing/invoices", {
    detail: {
      invoice_number: await nextInvoiceNumber(),
      currency_code: currency,
      note: input.note,
      payment_term: { due_date: input.dueDate },
    },
    invoicer: {
      business_name: process.env.OWED_BUSINESS_NAME ?? "Owed Demo Studio",
    },
    primary_recipients: [
      {
        billing_info: {
          name: { given_name: given, surname: rest.join(" ") || undefined },
          email_address: input.clientEmail,
        },
      },
    ],
    items: input.items.map((i) => ({
      name: i.name,
      description: i.description,
      quantity: String(i.quantity),
      unit_amount: { currency_code: currency, value: i.unitPrice.toFixed(2) },
      unit_of_measure: "QUANTITY",
    })),
    configuration: input.allowPartialPayment
      ? {
          allow_tip: false,
          partial_payment: {
            allow_partial_payment: true,
            minimum_amount_due: input.minimumAmountDue
              ? { currency_code: currency, value: input.minimumAmountDue.toFixed(2) }
              : undefined,
          },
        }
      : undefined,
  });
}

export async function sendInvoice(id: string, subject?: string, note?: string) {
  return pp("POST", `/v2/invoicing/invoices/${id}/send`, {
    subject,
    note,
    send_to_invoicer: true,
    send_to_recipient: true,
  });
}

export async function getInvoice(id: string) {
  return pp<Invoice>("GET", `/v2/invoicing/invoices/${id}`);
}

export async function listInvoices(page = 1, pageSize = 50) {
  return pp<{ items?: Invoice[]; total_items?: number }>(
    "GET",
    `/v2/invoicing/invoices?page=${page}&page_size=${pageSize}&total_required=true`,
  );
}

export async function remindInvoice(id: string, subject: string, note: string) {
  return pp("POST", `/v2/invoicing/invoices/${id}/remind`, {
    subject,
    note,
    send_to_invoicer: true,
    send_to_recipient: true,
  });
}

export async function cancelInvoice(id: string, subject: string, note: string) {
  return pp("POST", `/v2/invoicing/invoices/${id}/cancel`, {
    subject,
    note,
    send_to_invoicer: true,
    send_to_recipient: true,
  });
}

export async function recordExternalPayment(
  id: string,
  amount: number,
  currency: string,
  method: "BANK_TRANSFER" | "CASH" | "CHECK" | "OTHER",
  note?: string,
) {
  return pp("POST", `/v2/invoicing/invoices/${id}/payments`, {
    method,
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: currency, value: amount.toFixed(2) },
    note,
  });
}

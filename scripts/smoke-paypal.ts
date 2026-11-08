// Proves the PayPal sandbox integration end to end:
// auth → create draft invoice → send it → read it back.
// Run: npm run smoke:paypal  (needs PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / SANDBOX_CLIENT_EMAIL in .env.local)
import { createDraftInvoice, getInvoice, sendInvoice } from "../src/lib/paypal.ts";

const clientEmail = process.env.SANDBOX_CLIENT_EMAIL;
if (!clientEmail) {
  console.error("Set SANDBOX_CLIENT_EMAIL in .env.local to your sandbox *personal* account email.");
  process.exit(1);
}

const due = new Date(Date.now() + 14 * 86_400_000).toISOString().slice(0, 10);

const draft = await createDraftInvoice({
  clientEmail,
  clientName: "Acme Studio",
  dueDate: due,
  note: "Thanks for the work together!",
  items: [{ name: "Logo design", quantity: 1, unitPrice: 1200 }],
});
console.log("✓ draft created:", draft.id, draft.detail.invoice_number, draft.status);

await sendInvoice(draft.id, "Invoice from Owed Demo Studio");
const sent = await getInvoice(draft.id);
console.log("✓ sent. status:", sent.status);
console.log("  client pays here:", sent.detail.metadata?.recipient_view_url);

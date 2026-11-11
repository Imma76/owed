# Owed: the AI agent that gets freelancers paid

**Hackathon:** PayPal AI Hackathon (Devpost)
**Hard deadline:** Thu Nov 12, 2026, 12:00 PM Pacific (submit by the evening of Nov 11 to be safe)

## The pitch (30 seconds)
Freelancers lose hours, and real money, chasing invoices. Owed is an AI agent you talk to like an assistant:
"Bill Acme $1,200 for the logo, due in 14 days." It creates and sends a real PayPal invoice, watches for payment,
chases late clients in the right tone, offers payment plans when a client asks, and tells you who owes what.

## Mapped to the judging criteria (all weighted equally)
| Criterion | How Owed scores |
|---|---|
| Technological implementation | AI agent with 11 real PayPal tools (Invoicing v2, reminders, payments, refunds, Orders for payment plans, webhooks) |
| Design | One coherent product: chat + live ledger + client view, not a proof of concept |
| Potential impact | Specific audience (freelancers/contractors), specific pain (late payments), measurable outcome (days-to-paid) |
| Innovation | Agent negotiates payment plans and picks reminder tone from each client's payment history |
| Presentation | 2:45 video: problem → voice command → invoice in PayPal → client pays → ledger updates |

## Extra prizes we can also target (1 sponsor prize + 1 grand/honorable)
- **Best Use of Agentic Commerce** / **Best Use of PayPal + AI** (honorable mentions, $5k each)
- **AG Grid sponsor prize** ($5k / $2k / $1k): the invoice ledger is built with AG Grid
- **Render sponsor prize** (credits): deploy the hosted demo on Render

## Stack
- Next.js (App Router) + TypeScript + Tailwind
- OpenAI model via the `openai` SDK (chat completions + function calling), tools defined with Zod
- PayPal REST APIs called directly (sandbox): OAuth, Invoicing v2, Orders v2, Webhooks
- SQLite (better-sqlite3) for clients, invoice metadata, agent activity log
- AG Grid (React) for the ledger
- Deploy: Render

## Agent tools
1. `create_client` / `find_client`: client book
2. `create_and_send_invoice`: PayPal Invoicing v2 (draft → send)
3. `list_invoices` / `get_invoice_status`: sync status from PayPal
4. `send_reminder`: PayPal invoice remind endpoint, tone picked by the agent
5. `record_partial_payment` / `create_payment_plan`: split one invoice into installments
6. `cancel_invoice` / `refund_payment`
7. `cashflow_summary`: who owes what, overdue days, expected this week

## Day plan
- **Sat Nov 7:** scaffold, PayPal sandbox auth, create and send an invoice from code ✅ target
- **Sun Nov 8:** agent + tools working end to end in the chat UI
- **Mon Nov 9:** ledger (AG Grid), client view, payment-plan flow, webhook/poll status sync
- **Tue Nov 10:** polish UI, seed demo data, deploy to Render, README + license
- **Wed Nov 11:** record video, write Devpost description, SUBMIT
- **Thu Nov 12 (before noon PT):** buffer only

## Things only you can do
1. Join the hackathon on Devpost (paypalaihackathon.devpost.com → Join Hackathon).
2. Create a PayPal developer account at developer.paypal.com, create a sandbox REST app, and put its
   Client ID + Secret in `owed/.env.local` (template in `.env.example`).
3. Have an OpenAI API key for the agent.
4. A public GitHub repo for the submission (we'll push when ready).

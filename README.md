# Owed: the AI agent that gets freelancers paid

**Tell Owed who to bill. It sends real PayPal invoices, notices who's late, follows up in the right tone and sets up payment plans when a client needs one.**

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/).

- 🎥 **Demo video:** _add YouTube link_
- 🌐 **Live demo:** https://owed-rk4d.onrender.com (runs against the PayPal sandbox; first load can take ~1 minute while the free server wakes up)

---

## The problem

Freelancers and small studios do the work, then spend hours being their own collections department: writing invoices, checking who paid, working up the nerve to send the third "just following up" email. Late payments are among the most common complaints of independent workers, and every day an invoice sits unpaid is cash flow they don't have.

Invoicing tools already exist. What's missing is someone who does the *chasing*: knows which client always pays late, words the reminder so the relationship survives, and says "sure, three installments" when a client is struggling.

## What Owed does

You talk to Owed like you'd talk to a sharp bookkeeper, by typing or by voice:

| You say | Owed does in PayPal |
|---|---|
| "Bill Acme Studio $1,200 for the logo and $300 for the brand guide, due in 14 days" | Saves the client, creates a two-line PayPal invoice, sends it, and shows the pay link |
| "Who owes me money right now?" | Pulls every open invoice, works out what's overdue, totals what you're owed |
| "Chase anyone who's late" | Checks each client's payment history, then sends PayPal reminders: friendly for good payers, firm for repeat late payers |
| "Acme wants to pay in 3 monthly parts. That's fine, set it up" | Cancels the original invoice and sends three installment invoices with staggered due dates |
| "Acme paid $500 by bank transfer" | Records the offline payment against the invoice |

Every action appears live in the chat (each PayPal step with a check mark) and in the **What Owed has done** activity feed.

## How it uses PayPal

PayPal is the system of record. Owed never keeps its own copy of invoice state; it reads and writes PayPal directly:

| PayPal API | Used for |
|---|---|
| `POST /v1/oauth2/token` | Client-credentials auth (cached) |
| `POST /v2/invoicing/generate-next-invoice-number` | Sequential invoice numbers |
| `POST /v2/invoicing/invoices` | Create draft invoices (line items, due dates, partial payments) |
| `POST /v2/invoicing/invoices/{id}/send` | Email the invoice and pay link to the client |
| `GET /v2/invoicing/invoices`, `POST /v2/invoicing/search-invoices` | Live status, per-client history, cash-flow totals |
| `POST /v2/invoicing/invoices/{id}/remind` | Payment reminders with AI-written subject and message |
| `POST /v2/invoicing/invoices/{id}/cancel` | Cancelling, and replacing an invoice with a payment plan |
| `POST /v2/invoicing/invoices/{id}/payments` | Recording bank transfer, cash or check payments |

## How it uses AI

An OpenAI model (`gpt-5.5` by default) runs an agent loop with **11 tools** that wrap the PayPal APIs above:

`save_client` · `find_client` · `create_and_send_invoice` · `list_invoices` · `get_invoice` · `send_reminder` · `create_payment_plan` · `record_offline_payment` · `cancel_invoice` · `client_payment_history` · `cashflow_summary`

The agent decides which tools to call and in what order. For "send Acme a reminder" it looks up the client, finds the open invoice, reviews Acme's payment history and only then picks a tone and writes the message. Guardrails in the system prompt and the code:

- It never invents an email, amount or invoice ID; it looks them up or asks.
- Cancelling and payment plans happen only when the user clearly agrees.
- Every tool input is validated against a Zod schema before anything touches PayPal, and PayPal errors go back to the model so it can correct itself.

## Architecture

```
Browser (Next.js + React)
  │  chat, voice input, live tool steps, invoice cards, activity feed
  ▼
POST /api/agent ── streams NDJSON events (tool_start / tool_done / text)
  │
  ├── Agent loop (OpenAI chat completions + function calling)
  │     └── 11 tools (Zod-validated) ──► PayPal REST APIs (sandbox)
  │
  └── SQLite: client book, notes, payment plans, activity log, conversations
```

- `src/lib/paypal.ts`: typed PayPal REST client
- `src/lib/agent/tools.ts`: the 11 tools
- `src/lib/agent/agent.ts`: system prompt and agent loop
- `src/components/Chat.tsx`: the UI

## Run it yourself

**Needs:** Node 22+, a PayPal developer account (free) and an OpenAI API key.

1. **PayPal sandbox app:** at [developer.paypal.com](https://developer.paypal.com/), go to **Apps & Credentials → Sandbox → Create App** and copy the Client ID and Secret.
2. **Sandbox client:** under **Testing Tools → Sandbox Accounts**, copy the email of the **Personal** account. It plays the client who receives and pays invoices.
3. **Configure and run:**

   ```bash
   git clone <this repo> && cd owed
   npm install
   cp .env.example .env.local   # fill in the values from steps 1–2 and your OPENAI_API_KEY
   npm run smoke:paypal         # optional: proves PayPal works (creates and sends one invoice)
   npm run dev
   ```

4. Open http://localhost:3000 and try: *"Bill Acme Studio (your-sandbox-personal-email) $1,200 for a logo, due in 14 days"*.

**To pay an invoice as the client:** open the "Client pay page" link on an invoice card and log in with the sandbox Personal account. After that, *"Who owes me money?"* shows it as paid.

### Testing the hosted demo

The live demo runs on the PayPal sandbox, so no real money moves. It allows a limited number of agent requests per hour per visitor.

_Sandbox client login for paying invoices: add the sandbox Personal account email and password here before submitting._

## Built with

Next.js 16 · React 19 · TypeScript · Tailwind CSS · OpenAI API · PayPal Invoicing API v2 · SQLite (better-sqlite3) · Zod · Render

## License

[MIT](LICENSE)

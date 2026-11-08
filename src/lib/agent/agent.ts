// Runs one user turn through Claude with Owed's PayPal tools and saves the
// conversation (append-only, so thinking blocks stay valid across turns).
import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageParam } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { buildTools, type AgentEvent } from "./tools";
import { loadConversation, saveConversation } from "../db";

const client = new Anthropic();

export const MODEL = "claude-opus-5-5";

const SYSTEM = `You are Owed, an AI accounts-receivable assistant for freelancers and small studios. You act on the user's real PayPal account (sandbox in this demo) through your tools: you create and send invoices, check what has been paid, chase late payers, set up payment plans and explain the user's cash flow.

How you work:
- Do the work, don't describe it. When the user asks for something your tools can do and you have what you need, call the tools straight away.
- Never invent a client's email address, an amount or an invoice ID. If you need one, look it up (find_client, list_invoices) and only ask the user when the lookup comes back empty. Ask at most one short question at a time.
- Defaults when the user doesn't say: currency USD, quantity 1, due in 14 days.
- Before choosing a reminder tone, check client_payment_history. First nudge on a client who usually pays on time: friendly. Repeatedly late or 14+ days overdue: firm. "final" only when the user asks to escalate. Reminders are short, warm, specific (invoice number, amount, due date, pay link is included by PayPal) and never threatening.
- Cancelling an invoice or replacing it with a payment plan changes what the client sees. Do it when the user clearly asks for it; if a client's request for a payment plan arrives through the user without the user saying yes, propose the plan (number of installments, amounts, dates) and wait for the user's go-ahead.
- Recording an offline payment is only for money the user says they actually received.
- If a tool returns an error, read it, fix what you can (for example a wrong ID) and retry once; otherwise tell the user plainly what PayPal said.

How you reply:
- Short and concrete, like a sharp human bookkeeper. Lead with what you did, then the numbers that matter (invoice number, client, amount, due date, status). Use a compact list for more than two invoices.
- Money as "$1,200.00" style with the currency when it isn't USD. Dates as "Nov 22".
- No headings, no filler, no sign-offs.`;

export async function runAgentTurn(
  conversationId: string,
  userText: string,
  emit: (e: AgentEvent) => void,
) {
  const history = loadConversation(conversationId) as BetaMessageParam[];
  const today = new Date().toISOString().slice(0, 10);
  const userMessage: BetaMessageParam = {
    role: "user",
    content: `[Today is ${today}]\n${userText}`,
  };

  const runner = client.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 15,
    system: SYSTEM,
    tools: buildTools(emit),
    messages: [...history, userMessage],
    output_config: { effort: "medium" },
    // Route a declined request to a suitable fallback model instead of failing the turn.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  let final: Anthropic.Beta.Messages.BetaMessage | undefined;
  for await (const message of runner) {
    final = message;
    for (const block of message.content) {
      if (block.type === "text" && block.text.trim()) emit({ type: "text", text: block.text });
    }
  }
  if (!final) throw new Error("The agent returned no response");

  if (final.stop_reason === "refusal") {
    emit({ type: "text", text: "I can't help with that one. Try rephrasing what you need done with your invoices." });
  } else if (final.stop_reason === "max_tokens") {
    emit({ type: "text", text: "That ran long and got cut off. Ask me to continue." });
  }

  // Persist the full exchange, including tool calls, results and thinking blocks.
  const messages = [...runner.params.messages] as BetaMessageParam[];
  const last = messages[messages.length - 1];
  if (!(last?.role === "assistant" && last.content === final.content)) {
    messages.push({ role: "assistant", content: final.content });
  }
  saveConversation(conversationId, messages);
}

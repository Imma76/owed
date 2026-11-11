// Runs one user turn through the OpenAI model with Owed's PayPal tools and
// saves the conversation so the agent remembers context across turns.
import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageFunctionToolCall,
} from "openai/resources/chat/completions/completions";
import { buildTools, type AgentEvent } from "./tools";
import { toOpenAITool, type AgentTool } from "./define-tool";
import { loadConversation, saveConversation } from "../db";

const client = new OpenAI();

export const MODEL = process.env.OPENAI_MODEL || "gpt-5.5";
const MAX_STEPS = 15;

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
- Plain text only: no markdown headings, bold or tables, no filler, no sign-offs.`;

async function runTool(tools: Map<string, AgentTool>, call: ChatCompletionMessageFunctionToolCall): Promise<string> {
  const tool = tools.get(call.function.name);
  if (!tool) return JSON.stringify({ error: `Unknown tool ${call.function.name}` });
  let raw: unknown;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    return JSON.stringify({ error: "Arguments were not valid JSON. Call the tool again with valid JSON." });
  }
  const parsed = tool.inputSchema.safeParse(raw);
  if (!parsed.success) {
    return JSON.stringify({ error: "Invalid arguments", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) });
  }
  try {
    return await tool.run(parsed.data);
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

export async function runAgentTurn(conversationId: string, userText: string, emit: (e: AgentEvent) => void) {
  const toolList = buildTools(emit) as AgentTool[];
  const tools = new Map(toolList.map((t) => [t.name, t]));
  const declarations = toolList.map(toOpenAITool);

  const history = loadConversation(conversationId) as ChatCompletionMessageParam[];
  const today = new Date().toISOString().slice(0, 10);
  const messages: ChatCompletionMessageParam[] = [
    ...history,
    { role: "user", content: `[Today is ${today}]\n${userText}` },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const completion = await client.chat.completions.create({
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        tools: declarations,
        tool_choice: "auto",
      });
      const choice = completion.choices[0];
      const msg = choice.message;

      const calls = (msg.tool_calls ?? []).filter(
        (c): c is ChatCompletionMessageFunctionToolCall => c.type === "function",
      );
      messages.push({
        role: "assistant",
        content: msg.content ?? null,
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      if (msg.content?.trim()) emit({ type: "text", text: msg.content });

      if (!calls.length) {
        if (choice.finish_reason === "length") emit({ type: "text", text: "That ran long and got cut off. Ask me to continue." });
        if (msg.refusal) emit({ type: "text", text: msg.refusal });
        return;
      }

      // Run this step's tool calls in parallel; every call gets a result message.
      const results = await Promise.all(calls.map((c) => runTool(tools, c)));
      calls.forEach((c, i) => messages.push({ role: "tool", tool_call_id: c.id, content: results[i] }));
    }
    emit({ type: "text", text: "I hit my step limit for one request. Tell me what to do next." });
  } finally {
    // Save only complete exchanges: drop a trailing assistant tool call with no results.
    const last = messages[messages.length - 1];
    if (last?.role === "assistant" && "tool_calls" in last && last.tool_calls?.length) messages.pop();
    saveConversation(conversationId, messages);
  }
}

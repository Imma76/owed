// POST { conversationId, message } → streams newline-delimited JSON AgentEvents.
import { z } from "zod";
import Anthropic from "@anthropic-ai/sdk";
import { runAgentTurn } from "@/lib/agent/agent";
import type { AgentEvent } from "@/lib/agent/tools";

export const maxDuration = 300;

const Body = z.object({
  conversationId: z.string().min(8).max(64),
  message: z.string().min(1).max(4000),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid request" }, { status: 400 });
  const { conversationId, message } = parsed.data;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: AgentEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      try {
        await runAgentTurn(conversationId, message, emit);
        emit({ type: "done" });
      } catch (err) {
        let error = "Something went wrong talking to the agent.";
        if (err instanceof Anthropic.AuthenticationError) error = "Anthropic API key is missing or invalid (check .env.local).";
        else if (err instanceof Anthropic.RateLimitError) error = "Rate limited by the Anthropic API. Wait a moment and try again.";
        else if (err instanceof Anthropic.BadRequestError && /credit balance/i.test(err.message))
          error = "The Anthropic account behind ANTHROPIC_API_KEY is out of credits. Add credits in the Claude Console (Plans & Billing), then try again.";
        else if (err instanceof Anthropic.APIError) error = `Anthropic API error ${err.status}: ${err.message}`;
        else if (err instanceof Error) error = err.message;
        console.error("[agent]", err);
        emit({ type: "error", error });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

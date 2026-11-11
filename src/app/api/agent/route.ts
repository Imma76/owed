// POST { conversationId, message } → streams newline-delimited JSON AgentEvents.
import { z } from "zod";
import OpenAI from "openai";
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
        if (err instanceof OpenAI.AuthenticationError) error = "OpenAI API key is missing or invalid (check OPENAI_API_KEY in .env.local).";
        else if (err instanceof OpenAI.RateLimitError)
          error = /quota/i.test(err.message)
            ? "The OpenAI account behind OPENAI_API_KEY has no quota left. Add billing credit at platform.openai.com, then try again."
            : "Rate limited by the OpenAI API. Wait a moment and try again.";
        else if (err instanceof OpenAI.NotFoundError) error = `Model not available to this key: ${err.message}`;
        else if (err instanceof OpenAI.APIError) error = `OpenAI API error ${err.status}: ${err.message}`;
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

// Provider-neutral tool definition: a Zod schema the model fills in, and the code that runs it.
import { z } from "zod";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions/completions";

export type AgentTool<S extends z.ZodType = z.ZodType> = {
  name: string;
  description: string;
  inputSchema: S;
  run: (args: z.infer<S>) => Promise<string>;
};

export function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}

/** OpenAI function-tool declaration generated from the Zod schema. */
export function toOpenAITool(tool: AgentTool): ChatCompletionFunctionTool {
  // io: "input" so fields with defaults are optional for the model.
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.inputSchema, { io: "input" }) as Record<string, unknown>;
  void _ignored;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters },
  };
}

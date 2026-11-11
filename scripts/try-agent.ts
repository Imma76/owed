// Sends messages to the running dev server's agent and prints what it did.
// Usage: node --env-file=.env.local --experimental-strip-types scripts/try-agent.ts <conversationId> "message" ["message" ...]
const [conversationId, ...prompts] = process.argv.slice(2);
const email = process.env.SANDBOX_CLIENT_EMAIL ?? "";
const base = process.env.OWED_URL ?? "http://localhost:3000";

for (const raw of prompts) {
  const message = raw.replaceAll("{client}", email);
  console.log(`\n=== USER: ${raw}`);
  const res = await fetch(`${base}/api/agent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ conversationId, message }),
  });
  const text = await res.text();
  for (const line of text.split("\n").filter(Boolean)) {
    const e = JSON.parse(line.replaceAll(email, "[client-email]"));
    if (e.type === "tool_done") {
      const inv = e.invoice;
      console.log("  ✓", e.label, inv ? `[#${inv.number} ${inv.status} $${inv.due} due ${inv.dueDate}]` : "");
    } else if (e.type === "tool_error") console.log("  ✗", e.label, e.error);
    else if (e.type === "text") console.log("AGENT:", e.text);
    else if (e.type === "error") console.log("ERROR:", e.error);
  }
}

export {};

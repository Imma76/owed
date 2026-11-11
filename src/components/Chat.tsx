"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { AgentEvent } from "@/lib/agent/tools";
import type { InvoiceView } from "@/lib/invoice-view";

type Step = { tool: string; label: string; state: "running" | "done" | "error"; error?: string };
type Turn =
  | { role: "user"; text: string }
  | { role: "agent"; texts: string[]; steps: Step[]; invoices: InvoiceView[]; error?: string; pending: boolean };

type Activity = { id: number; at: string; kind: string; summary: string };

const SUGGESTIONS = [
  "Bill Acme Studio (acme@example.com) $1,200 for the logo design, due in 14 days",
  "Who owes me money right now?",
  "Chase anyone who's late, in the right tone",
  "Acme wants to pay the logo invoice in 3 monthly parts. That's fine, set it up",
];

const money = (n: number, cur = "USD") =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(n);

const shortDate = (iso: string | null) =>
  iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "–";

function newId() {
  return crypto.randomUUID();
}

function readStoredId(): string | null {
  if (typeof window === "undefined") return null;
  let value: string | null = null;
  try {
    value = localStorage.getItem("owed:conversation");
  } catch {}
  if (!value) {
    value = newId();
    try {
      localStorage.setItem("owed:conversation", value);
    } catch {}
  }
  return value;
}

// The id is never rendered, so reading it during the client's first render is hydration-safe.
function useConversationId() {
  const [id, setId] = useState<string | null>(readStoredId);
  const reset = useCallback(() => {
    const value = newId();
    try {
      localStorage.setItem("owed:conversation", value);
    } catch {}
    setId(value);
  }, []);
  return [id, reset] as const;
}

export default function Chat() {
  const [conversationId, resetConversation] = useConversationId();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<Activity[]>([]);
  const scroller = useRef<HTMLDivElement>(null);

  const refreshActivity = useCallback(async () => {
    try {
      const r = await fetch("/api/activity", { cache: "no-store" });
      const j = await r.json();
      setActivity(j.activity ?? []);
    } catch {}
  }, []);

  useEffect(() => {
    refreshActivity();
  }, [refreshActivity]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  const updateAgent = (fn: (t: Extract<Turn, { role: "agent" }>) => void) =>
    setTurns((prev) => {
      const next = [...prev];
      const last = next[next.length - 1];
      if (last?.role === "agent") {
        const copy = { ...last, texts: [...last.texts], steps: [...last.steps], invoices: [...last.invoices] };
        fn(copy);
        next[next.length - 1] = copy;
      }
      return next;
    });

  async function send(text: string) {
    const message = text.trim();
    if (!message || busy || !conversationId) return;
    setInput("");
    setBusy(true);
    setTurns((t) => [
      ...t,
      { role: "user", text: message },
      { role: "agent", texts: [], steps: [], invoices: [], pending: true },
    ]);

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId, message }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const e = JSON.parse(line) as AgentEvent;
          updateAgent((a) => {
            if (e.type === "text") a.texts.push(e.text);
            else if (e.type === "tool_start") a.steps.push({ tool: e.tool, label: e.label, state: "running" });
            else if (e.type === "tool_done" || e.type === "tool_error") {
              for (let i = a.steps.length - 1; i >= 0; i--) {
                if (a.steps[i].tool === e.tool && a.steps[i].state === "running") {
                  a.steps[i] = { ...a.steps[i], state: e.type === "tool_done" ? "done" : "error", error: e.type === "tool_error" ? e.error : undefined };
                  break;
                }
              }
              if (e.type === "tool_done" && e.invoice) {
                const idx = a.invoices.findIndex((x) => x.id === e.invoice!.id);
                if (idx >= 0) a.invoices[idx] = e.invoice;
                else a.invoices.push(e.invoice);
              }
            } else if (e.type === "error") a.error = e.error;
          });
        }
      }
    } catch (err) {
      updateAgent((a) => {
        a.error = err instanceof Error ? err.message : "Connection lost";
      });
    } finally {
      updateAgent((a) => {
        a.pending = false;
      });
      setBusy(false);
      refreshActivity();
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Main chat column */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <div className="flex items-baseline gap-3">
            <span className="text-lg font-semibold tracking-tight">Owed</span>
            <span className="hidden text-sm text-muted sm:inline">the agent that gets you paid</span>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-accent-soft px-2.5 py-1 text-xs font-medium text-accent">PayPal sandbox</span>
            <button
              onClick={() => {
                resetConversation();
                setTurns([]);
              }}
              className="rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-surface hover:text-ink"
            >
              New chat
            </button>
          </div>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-8 sm:px-6">
            {turns.length === 0 && <Empty onPick={send} />}
            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="rise self-end max-w-[85%] rounded-2xl rounded-br-md bg-ink px-4 py-2.5 text-[15px] text-bg">
                  {t.text}
                </div>
              ) : (
                <AgentTurn key={i} turn={t} />
              ),
            )}
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            send(input);
          }}
          className="border-t border-line bg-bg px-4 py-3 sm:px-6"
        >
          <div className="mx-auto flex max-w-2xl items-end gap-2 rounded-2xl border border-line bg-surface p-2 focus-within:border-ink/30">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(input);
                }
              }}
              rows={1}
              placeholder="Bill a client, chase a late payment, ask who owes you…"
              className="max-h-40 min-h-[40px] flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none placeholder:text-muted"
            />
            <MicButton onText={(t) => setInput((v) => (v ? v + " " : "") + t)} disabled={busy} />
            <button
              type="submit"
              disabled={busy || !input.trim()}
              className="h-10 rounded-xl bg-accent px-4 text-sm font-medium text-white transition-opacity disabled:opacity-40 dark:text-black"
            >
              {busy ? "Working…" : "Send"}
            </button>
          </div>
        </form>
      </main>

      {/* Activity sidebar */}
      <aside className="hidden w-80 shrink-0 flex-col border-l border-line bg-surface lg:flex">
        <div className="border-b border-line px-5 py-3.5 text-sm font-medium">What Owed has done</div>
        <ol className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {activity.length === 0 && <li className="py-2 text-sm text-muted">Nothing yet. Actions on PayPal show up here.</li>}
          {activity.map((a) => (
            <li key={a.id} className="border-b border-line/70 py-3 last:border-0">
              <div className="text-[13px] leading-snug">{a.summary}</div>
              <div className="mt-1 text-xs text-muted">
                {new Date(a.at.replace(" ", "T") + "Z").toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
              </div>
            </li>
          ))}
        </ol>
      </aside>
    </div>
  );
}

function Empty({ onPick }: { onPick: (t: string) => void }) {
  return (
    <div className="rise pt-10 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight text-balance">Stop chasing invoices.</h1>
      <p className="mt-2 max-w-md text-[15px] text-muted text-pretty">
        Tell Owed who to bill. It sends real PayPal invoices, notices who&apos;s late, follows up in the right tone and sets up
        payment plans when a client needs one.
      </p>
      <div className="mt-8 grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="rounded-xl border border-line bg-surface px-4 py-3 text-left text-sm leading-snug transition-colors hover:border-ink/25"
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentTurn({ turn }: { turn: Extract<Turn, { role: "agent" }> }) {
  return (
    <div className="rise flex flex-col gap-3">
      {turn.steps.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {turn.steps.map((s, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-muted">
              <StepIcon state={s.state} />
              <span className={s.state === "error" ? "text-danger" : undefined}>
                {s.label}
                {s.error ? `: ${s.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      {turn.invoices.map((inv) => (
        <InvoiceCard key={inv.id} inv={inv} />
      ))}

      {turn.texts.length > 0 && (
        <div className="whitespace-pre-wrap text-[15px] leading-relaxed">{turn.texts[turn.texts.length - 1]}</div>
      )}

      {turn.pending && turn.steps.length === 0 && turn.texts.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <StepIcon state="running" /> Thinking
        </div>
      )}

      {turn.error && (
        <div className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{turn.error}</div>
      )}
    </div>
  );
}

function StepIcon({ state }: { state: Step["state"] }) {
  if (state === "running")
    return <span aria-label="running" className="inline-block size-3.5 animate-spin rounded-full border-2 border-muted/40 border-t-accent" />;
  if (state === "error") return <span aria-label="failed" className="inline-block size-3.5 rounded-full bg-danger" />;
  return (
    <svg aria-label="done" viewBox="0 0 16 16" className="size-3.5 text-accent">
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const STATUS_STYLE: Record<string, string> = {
  PAID: "bg-accent-soft text-accent",
  MARKED_AS_PAID: "bg-accent-soft text-accent",
  PARTIALLY_PAID: "bg-warn-soft text-warn",
  CANCELLED: "bg-line text-muted",
  DRAFT: "bg-line text-muted",
};

function InvoiceCard({ inv }: { inv: InvoiceView }) {
  const overdue = inv.daysOverdue > 0;
  const style = overdue ? "bg-danger-soft text-danger" : (STATUS_STYLE[inv.status] ?? "bg-ink/5 text-ink");
  const label = overdue ? `${inv.daysOverdue}d overdue` : inv.status.replaceAll("_", " ").toLowerCase();
  return (
    <div className="rise rounded-xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs text-muted">Invoice #{inv.number}</div>
          <div className="mt-0.5 truncate font-medium">{inv.client}</div>
          <div className="mt-0.5 truncate text-sm text-muted">{inv.items}</div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold">{money(inv.due > 0 ? inv.due : inv.total, inv.currency)}</div>
          <span className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium capitalize ${style}`}>{label}</span>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3 text-sm">
        <span className="text-muted">Due {shortDate(inv.dueDate)}</span>
        {inv.payLink && (
          <a href={inv.payLink} target="_blank" rel="noreferrer" className="font-medium text-accent hover:underline">
            Client pay page ↗
          </a>
        )}
      </div>
    </div>
  );
}

// Voice input via the browser's speech recognition, when available.
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  onresult: (e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void;
  onend: () => void;
  start: () => void;
  stop: () => void;
};

type SpeechCtor = new () => SpeechRec;

function getSpeechCtor(): SpeechCtor | undefined {
  const w = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

const noopSubscribe = () => () => {};

function MicButton({ onText, disabled }: { onText: (t: string) => void; disabled: boolean }) {
  // false on the server, real answer in the browser, without a setState-in-effect.
  const supported = useSyncExternalStore(noopSubscribe, () => !!getSpeechCtor(), () => false);
  const [listening, setListening] = useState(false);
  const rec = useRef<SpeechRec | null>(null);

  if (!supported) return null;
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={listening ? "Stop listening" : "Speak"}
      onClick={() => {
        if (listening) {
          rec.current?.stop();
          return;
        }
        const Ctor = getSpeechCtor();
        if (!Ctor) return;
        const r = new Ctor();
        r.lang = "en-US";
        r.interimResults = false;
        r.onresult = (e) => onText(Array.from(e.results).map((x) => x[0].transcript).join(" "));
        r.onend = () => setListening(false);
        rec.current = r;
        r.start();
        setListening(true);
      }}
      className={`grid size-10 place-items-center rounded-xl transition-colors disabled:opacity-40 ${listening ? "bg-danger text-white" : "text-muted hover:bg-bg hover:text-ink"}`}
    >
      <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
        <rect x="9" y="3" width="6" height="11" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
      </svg>
    </button>
  );
}

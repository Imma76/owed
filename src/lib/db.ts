// Local state Owed keeps next to PayPal: the client book, payment plans,
// the agent's activity log and saved conversations. PayPal stays the source
// of truth for invoices themselves.
import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";

const DB_PATH = process.env.OWED_DB_PATH ?? path.join(process.cwd(), "data", "owed.db");

declare global {
  // Reuse one connection across Next.js hot reloads.
  var __owedDb: Database.Database | undefined;
}

function open() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS payment_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      original_invoice_id TEXT NOT NULL,
      client_email TEXT NOT NULL,
      total TEXT NOT NULL,
      currency TEXT NOT NULL,
      installment_invoice_ids TEXT NOT NULL, -- JSON array
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL DEFAULT (datetime('now')),
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      invoice_id TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      messages TEXT NOT NULL, -- JSON array of BetaMessageParam, append-only
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export const db = globalThis.__owedDb ?? (globalThis.__owedDb = open());

// ---------- clients ----------
export type Client = { id: number; name: string; email: string; notes: string | null };

export function upsertClient(name: string, email: string, notes?: string): Client {
  db.prepare(
    `INSERT INTO clients (name, email, notes) VALUES (?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET name = excluded.name,
       notes = COALESCE(excluded.notes, clients.notes)`,
  ).run(name, email, notes ?? null);
  return db.prepare(`SELECT * FROM clients WHERE email = ?`).get(email) as Client;
}

export function findClients(query: string): Client[] {
  const q = `%${query}%`;
  return db
    .prepare(`SELECT * FROM clients WHERE name LIKE ? OR email LIKE ? ORDER BY name LIMIT 10`)
    .all(q, q) as Client[];
}

export function allClients(): Client[] {
  return db.prepare(`SELECT * FROM clients ORDER BY name`).all() as Client[];
}

// ---------- activity ----------
export type Activity = { id: number; at: string; kind: string; summary: string; invoice_id: string | null };

export function logActivity(kind: string, summary: string, invoiceId?: string) {
  db.prepare(`INSERT INTO activity (kind, summary, invoice_id) VALUES (?, ?, ?)`).run(
    kind,
    summary,
    invoiceId ?? null,
  );
}

export function recentActivity(limit = 30): Activity[] {
  return db.prepare(`SELECT * FROM activity ORDER BY id DESC LIMIT ?`).all(limit) as Activity[];
}

// ---------- payment plans ----------
export function savePaymentPlan(p: {
  originalInvoiceId: string;
  clientEmail: string;
  total: string;
  currency: string;
  installmentIds: string[];
}) {
  db.prepare(
    `INSERT INTO payment_plans (original_invoice_id, client_email, total, currency, installment_invoice_ids)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(p.originalInvoiceId, p.clientEmail, p.total, p.currency, JSON.stringify(p.installmentIds));
}

// ---------- conversations ----------
export function loadConversation(id: string): unknown[] {
  const row = db.prepare(`SELECT messages FROM conversations WHERE id = ?`).get(id) as
    | { messages: string }
    | undefined;
  return row ? JSON.parse(row.messages) : [];
}

export function saveConversation(id: string, messages: unknown[]) {
  db.prepare(
    `INSERT INTO conversations (id, messages, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
  ).run(id, JSON.stringify(messages));
}

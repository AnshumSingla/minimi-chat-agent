import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { config } from "./config";
import type { ConversationSummary, SourceRef, UiMessage } from "./types";

/**
 * Local-only storage. One SQLite file under ./data (gitignored).
 * Timestamps are UTC ISO-8601 strings, which sort lexicographically.
 */

type DB = Database.Database;

const globalForDb = globalThis as unknown as { __minimiDb?: DB };

function open(): DB {
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user','assistant')),
      text TEXT NOT NULL,
      content_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(created_at);

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      published_date TEXT,
      retrieved_at TEXT NOT NULL,
      query TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sources_msg ON sources(message_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text, content='messages', content_rowid='rowid', tokenize='porter unicode61'
    );
    CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END;

    -- Local MiniLM vectors (Float32, 384 dims) for user messages; used for semantic recall.
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
      vec BLOB NOT NULL
    );
  `);
  return db;
}

/** Reuse one connection across Next.js hot reloads. */
export function db(): DB {
  if (!globalForDb.__minimiDb) globalForDb.__minimiDb = open();
  return globalForDb.__minimiDb;
}

const now = () => new Date().toISOString();

// ---------- conversations ----------

export function createConversation(title: string, at = now()): string {
  const id = randomUUID();
  db()
    .prepare("INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(id, title.slice(0, 80), at, at);
  return id;
}

export function conversationExists(id: string): boolean {
  return !!db().prepare("SELECT 1 FROM conversations WHERE id = ?").get(id);
}

export function listConversations(): ConversationSummary[] {
  return db()
    .prepare(
      "SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM conversations ORDER BY updated_at DESC",
    )
    .all() as ConversationSummary[];
}

export function deleteConversation(id: string): void {
  db().prepare("DELETE FROM conversations WHERE id = ?").run(id);
  db().exec("VACUUM");
}

export function deleteAll(): void {
  db().exec("DELETE FROM conversations; VACUUM;");
}

// ---------- messages ----------

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant";
  text: string;
  contentJson: string | null;
  createdAt: string;
}

const MESSAGE_COLS =
  "id, conversation_id AS conversationId, role, text, content_json AS contentJson, created_at AS createdAt";

export function addMessage(
  conversationId: string,
  role: "user" | "assistant",
  text: string,
  content?: unknown,
  at = now(),
): string {
  const id = randomUUID();
  const d = db();
  d.prepare(
    "INSERT INTO messages (id, conversation_id, role, text, content_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(id, conversationId, role, text, content === undefined ? null : JSON.stringify(content), at);
  d.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(at, conversationId);
  return id;
}

export function addSources(
  messageId: string,
  sources: (SourceRef & { query?: string; retrievedAt: string })[],
): void {
  const stmt = db().prepare(
    "INSERT INTO sources (message_id, url, title, published_date, retrieved_at, query) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const tx = db().transaction(() => {
    for (const s of sources) {
      stmt.run(messageId, s.url, s.title, s.publishedDate, s.retrievedAt, s.query ?? null);
    }
  });
  tx();
}

export function recentMessages(conversationId: string, limit: number): StoredMessage[] {
  const rows = db()
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(conversationId, limit) as StoredMessage[];
  return rows.reverse();
}

export function sourcesFor(messageIds: string[]): Map<string, (SourceRef & { retrievedAt: string })[]> {
  const out = new Map<string, (SourceRef & { retrievedAt: string })[]>();
  if (messageIds.length === 0) return out;
  const rows = db()
    .prepare(
      `SELECT message_id AS messageId, url, title, published_date AS publishedDate, retrieved_at AS retrievedAt
       FROM sources WHERE message_id IN (${messageIds.map(() => "?").join(",")})`,
    )
    .all(...messageIds) as (SourceRef & { messageId: string; retrievedAt: string })[];
  for (const { messageId, ...s } of rows) {
    const list = out.get(messageId) ?? [];
    if (!list.some((x) => x.url === s.url)) list.push(s);
    out.set(messageId, list);
  }
  return out;
}

export function uiMessages(conversationId: string): UiMessage[] {
  const msgs = db()
    .prepare(`SELECT ${MESSAGE_COLS} FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(conversationId) as StoredMessage[];
  const src = sourcesFor(msgs.filter((m) => m.role === "assistant").map((m) => m.id));
  return msgs.map((m) => ({
    id: m.id,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
    sources: (src.get(m.id) ?? []).map(({ url, title, publishedDate }) => ({ url, title, publishedDate })),
  }));
}

// ---------- recall queries ----------

/** User messages in [fromIso, toIso), oldest first, optionally excluding one conversation. */
export function userMessagesBetween(fromIso: string, toIso: string, excludeConv?: string): StoredMessage[] {
  return db()
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM messages
       WHERE role = 'user' AND created_at >= ? AND created_at < ? AND conversation_id != ?
       ORDER BY created_at ASC LIMIT 50`,
    )
    .all(fromIso, toIso, excludeConv ?? "") as StoredMessage[];
}

/** Full-text search over past user messages, best match first. */
export function searchUserMessages(ftsQuery: string, excludeConv: string | undefined, limit: number): StoredMessage[] {
  if (!ftsQuery) return [];
  try {
    return db()
      .prepare(
        `SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.content_json AS contentJson,
                m.created_at AS createdAt
         FROM messages_fts f JOIN messages m ON m.rowid = f.rowid
         WHERE messages_fts MATCH ? AND m.role = 'user' AND m.conversation_id != ?
         ORDER BY bm25(messages_fts) LIMIT ?`,
      )
      .all(ftsQuery, excludeConv ?? "", limit) as StoredMessage[];
  } catch {
    return []; // malformed FTS query: treat as no match
  }
}

// ---------- embeddings ----------

export function saveEmbeddings(rows: { messageId: string; vec: Float32Array }[]): void {
  const stmt = db().prepare("INSERT OR REPLACE INTO message_embeddings (message_id, vec) VALUES (?, ?)");
  db().transaction(() => {
    for (const r of rows) stmt.run(r.messageId, Buffer.from(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength));
  })();
}

/** User messages without a vector yet (e.g. written before the model was available, or seeded). */
export function userMessagesMissingEmbeddings(limit: number): { id: string; text: string }[] {
  return db()
    .prepare(
      `SELECT m.id, m.text FROM messages m LEFT JOIN message_embeddings e ON e.message_id = m.id
       WHERE m.role = 'user' AND e.message_id IS NULL ORDER BY m.created_at DESC LIMIT ?`,
    )
    .all(limit) as { id: string; text: string }[];
}

/** All user-message vectors outside one conversation. Fine for a personal history (thousands of rows). */
export function userEmbeddings(excludeConv?: string): { message: StoredMessage; vec: Float32Array }[] {
  const rows = db()
    .prepare(
      `SELECT m.id, m.conversation_id AS conversationId, m.role, m.text, m.content_json AS contentJson,
              m.created_at AS createdAt, e.vec AS vec
       FROM message_embeddings e JOIN messages m ON m.id = e.message_id
       WHERE m.role = 'user' AND m.conversation_id != ?`,
    )
    .all(excludeConv ?? "") as (StoredMessage & { vec: Buffer })[];
  return rows.map(({ vec, ...message }) => ({
    message,
    vec: new Float32Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength)),
  }));
}

/** The assistant reply that directly follows a user message. */
export function replyTo(userMsg: StoredMessage): StoredMessage | undefined {
  return db()
    .prepare(
      `SELECT ${MESSAGE_COLS} FROM messages
       WHERE conversation_id = ? AND role = 'assistant' AND created_at >= ?
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(userMsg.conversationId, userMsg.createdAt) as StoredMessage | undefined;
}

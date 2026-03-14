import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, "../data/resume-tailor.db");

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id          TEXT PRIMARY KEY,
      status      TEXT NOT NULL DEFAULT 'queued',
      label       TEXT NOT NULL DEFAULT '',
      created_at  INTEGER NOT NULL,
      jd          TEXT NOT NULL DEFAULT '',
      error       TEXT
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id              TEXT PRIMARY KEY,
      base_resume     TEXT NOT NULL DEFAULT '',
      parsed_jd       TEXT NOT NULL DEFAULT '',
      ats_analysis    TEXT NOT NULL DEFAULT '',
      tailored_resume TEXT NOT NULL DEFAULT '',
      page_count      INTEGER NOT NULL DEFAULT 0,
      trim_attempts   INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      seq        INTEGER NOT NULL,
      type       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
  `);

  try {
    _db.exec(`ALTER TABLE sessions ADD COLUMN cover_letter TEXT NOT NULL DEFAULT ''`);
  } catch {}

  return _db;
}

// ── Job CRUD ──

export interface JobRow {
  id: string;
  status: string;
  label: string;
  created_at: number;
  jd: string;
  error: string | null;
}

export function insertJob(job: { id: string; status: string; label: string; createdAt: number; jd: string }) {
  getDb().prepare(
    `INSERT INTO jobs (id, status, label, created_at, jd) VALUES (?, ?, ?, ?, ?)`
  ).run(job.id, job.status, job.label, job.createdAt, job.jd);
}

export function updateJobStatus(id: string, status: string, label?: string, error?: string) {
  if (label !== undefined) {
    getDb().prepare(`UPDATE jobs SET status = ?, label = ?, error = ? WHERE id = ?`).run(status, label, error ?? null, id);
  } else {
    getDb().prepare(`UPDATE jobs SET status = ?, error = ? WHERE id = ?`).run(status, error ?? null, id);
  }
}

export function getAllJobs(): JobRow[] {
  return getDb().prepare(`SELECT * FROM jobs ORDER BY created_at DESC`).all() as JobRow[];
}

export function getJob(id: string): JobRow | undefined {
  return getDb().prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
}

// ── Session CRUD ──

export interface SessionRow {
  id: string;
  base_resume: string;
  parsed_jd: string;
  ats_analysis: string;
  tailored_resume: string;
  cover_letter: string;
  page_count: number;
  trim_attempts: number;
}

export function upsertSession(s: {
  id: string;
  baseResume: string;
  parsedJD: string;
  atsAnalysis: string;
  tailoredResume: string;
  coverLetter?: string;
  pageCount: number;
  trimAttempts: number;
}) {
  const cover = s.coverLetter ?? "";
  getDb().prepare(`
    INSERT INTO sessions (id, base_resume, parsed_jd, ats_analysis, tailored_resume, cover_letter, page_count, trim_attempts)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      base_resume = excluded.base_resume,
      parsed_jd = excluded.parsed_jd,
      ats_analysis = excluded.ats_analysis,
      tailored_resume = excluded.tailored_resume,
      cover_letter = excluded.cover_letter,
      page_count = excluded.page_count,
      trim_attempts = excluded.trim_attempts
  `).run(s.id, s.baseResume, s.parsedJD, s.atsAnalysis, s.tailoredResume, cover, s.pageCount, s.trimAttempts);
}

export function getSession(id: string): SessionRow | undefined {
  return getDb().prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

export function updateCoverLetter(sessionId: string, coverLetter: string) {
  getDb().prepare(`UPDATE sessions SET cover_letter = ? WHERE id = ?`).run(coverLetter, sessionId);
}

// ── Messages CRUD ──

export interface MessageRow {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  content: string;
}

export function replaceMessages(sessionId: string, messages: Array<{ type: string; content: string }>) {
  const db = getDb();
  const del = db.prepare(`DELETE FROM messages WHERE session_id = ?`);
  const ins = db.prepare(`INSERT INTO messages (session_id, seq, type, content) VALUES (?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    del.run(sessionId);
    messages.forEach((m, i) => ins.run(sessionId, i, m.type, m.content));
  });
  tx();
}

export function getMessages(sessionId: string): MessageRow[] {
  return getDb().prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY seq`).all(sessionId) as MessageRow[];
}

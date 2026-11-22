import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function resolveDataDir(opts = {}) {
  const dir = opts.dataDir || process.env.HEALTH_TIMELINE_DATA_DIR || path.join(REPO_ROOT, "build");
  return path.resolve(dir);
}

export function resolveDbPath(opts = {}) {
  if (opts.dbPath) return path.resolve(opts.dbPath);
  return path.join(resolveDataDir(opts), "timeline.sqlite");
}

export function resolveGuidelinesPath(opts = {}) {
  if (opts.guidelinesPath) return path.resolve(opts.guidelinesPath);
  if (process.env.HEALTH_TIMELINE_GUIDELINES_PATH) {
    return path.resolve(process.env.HEALTH_TIMELINE_GUIDELINES_PATH);
  }
  return path.join(resolveDataDir(opts), "regional-guidelines.md");
}

export function resolvePagesDir(opts = {}) {
  return path.join(resolveDataDir(opts), "pages");
}

export function resolveSourcesDir(opts = {}) {
  return path.join(resolveDataDir(opts), "sources");
}

export const SCHEMA_SQL = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS patient_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  full_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  dob TEXT,
  biological_sex TEXT,
  country TEXT NOT NULL DEFAULT 'US',
  ethnicity TEXT,
  pregnancy_status TEXT,
  conditions_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_path TEXT,
  sha256 TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  order_number TEXT,
  report_status TEXT,
  patient_name_raw TEXT,
  patient_dob_raw TEXT,
  patient_sex_raw TEXT,
  collected_at TEXT,
  reported_at TEXT,
  received_at TEXT,
  doc_type TEXT NOT NULL DEFAULT 'lab_report',
  page_count INTEGER NOT NULL DEFAULT 1,
  superseded_by TEXT REFERENCES documents(id),
  meta_json TEXT NOT NULL DEFAULT '{}',
  imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS skipped_documents (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  source_path TEXT,
  sha256 TEXT,
  provider TEXT,
  patient_name_raw TEXT,
  reason TEXT NOT NULL,
  detected_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  canonical_key TEXT NOT NULL,
  specimen TEXT NOT NULL,
  display_name TEXT NOT NULL,
  panel TEXT NOT NULL,
  value_num REAL,
  value_text TEXT NOT NULL,
  unit_raw TEXT,
  normalized_value REAL,
  normalized_unit TEXT,
  ref_low REAL,
  ref_high REAL,
  ref_text TEXT,
  flag TEXT NOT NULL DEFAULT 'unknown',
  method TEXT,
  collected_at TEXT,
  page INTEGER,
  line_index INTEGER,
  bbox_json TEXT,
  excerpt TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  meta_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  finding_type TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  followup_plan TEXT,
  collected_at TEXT,
  page INTEGER,
  bbox_json TEXT,
  excerpt TEXT
);

CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES documents(id) ON DELETE CASCADE,
  observation_id TEXT REFERENCES observations(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  received TEXT NOT NULL,
  channel TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_provider_order ON documents(provider, order_number);
CREATE INDEX IF NOT EXISTS idx_documents_collected ON documents(collected_at);
CREATE INDEX IF NOT EXISTS idx_observations_doc ON observations(document_id);
CREATE INDEX IF NOT EXISTS idx_observations_key_active ON observations(canonical_key, is_active, collected_at);
CREATE INDEX IF NOT EXISTS idx_observations_panel_active ON observations(panel, is_active);
CREATE INDEX IF NOT EXISTS idx_findings_doc ON findings(document_id);
CREATE INDEX IF NOT EXISTS idx_review_items_doc ON review_items(document_id, resolved);
CREATE INDEX IF NOT EXISTS idx_skipped_sha ON skipped_documents(sha256);
`;

export function initSchema(db) {
  db.exec(SCHEMA_SQL);
}

export function isLegacySchema(db) {
  try {
    const cols = db.prepare("PRAGMA table_info(observations)").all();
    const names = new Set(cols.map(c => c.name));
    return names.has("payload") && !names.has("canonical_key");
  } catch {
    return false;
  }
}

export function openDb(opts = {}) {
  const dbPath = resolveDbPath(opts);
  const readOnly = Boolean(opts.readOnly);
  if (!readOnly) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = readOnly
    ? new DatabaseSync(dbPath, { readOnly: true })
    : new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (!readOnly) {
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      db.exec("PRAGMA busy_timeout = 5000;");
    } catch {
      // Ignore WAL failure on read-only/special filesystems
    }
    initSchema(db);
  }
  return db;
}

export function withDb(opts, fn) {
  const options = typeof opts === "function" ? {} : (opts || {});
  const callback = typeof opts === "function" ? opts : fn;
  const db = openDb(options);
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

export function dbExists(opts = {}) {
  return fs.existsSync(resolveDbPath(opts));
}

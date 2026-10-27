-- Secretary v1: five small operational tables, not a document database.
-- Canonical Markdown and long-lived business JSON remain on disk.
-- Runtime initialization sets journal_mode=WAL outside migrations.
PRAGMA foreign_keys = ON;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
BEGIN;

CREATE TABLE schema_meta (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  applied_at TEXT NOT NULL,
  runtime_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(runtime_json))
);
INSERT INTO schema_meta(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE documents (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  updated_at TEXT NOT NULL
);

-- Short channel inputs only. Web document saves use references/hashes, no body.
CREATE TABLE inbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  external_id TEXT NOT NULL,
  body TEXT CHECK(body IS NULL OR length(CAST(body AS BLOB)) <= 16384),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(metadata_json)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','processing','processed','failed','ignored')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  received_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  processed_at TEXT,
  error_code TEXT,
  UNIQUE(channel, actor_ref, external_id),
  CHECK(status NOT IN ('processed','failed','ignored') OR processed_at IS NOT NULL)
);

-- Small commands/deltas and file references for forward recovery.
-- Never store complete Markdown, registry snapshots or model transcripts.
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT NOT NULL UNIQUE,
  input_id TEXT,
  parent_id TEXT REFERENCES events(id) ON DELETE RESTRICT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_key TEXT,
  document_path TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}'
    CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 65536),
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK(status IN ('prepared','applied','cancelled','conflict','failed')),
  created_at TEXT NOT NULL,
  completed_at TEXT,
  error_code TEXT,
  CHECK(status NOT IN ('applied','cancelled') OR completed_at IS NOT NULL)
);

-- body is cleared after 7 days; receipts/reply references survive for 30.
-- attempts_json stores short per-attempt timestamps/results for budget checks.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  target_refs_json TEXT NOT NULL CHECK(json_valid(target_refs_json)),
  source_versions_json TEXT NOT NULL CHECK(json_valid(source_versions_json)),
  message_kind TEXT NOT NULL CHECK(message_kind IN ('initial','follow_up','receipt','clarification','system')),
  body TEXT CHECK(body IS NULL OR length(body) <= 8000),
  content_hash TEXT,
  scheduled_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','sending','sent','failed','unknown','cancelled','expired','abandoned')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  attempts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(attempts_json)),
  counts_as_proactive INTEGER NOT NULL DEFAULT 1 CHECK(counts_as_proactive IN (0,1)),
  business_date TEXT,
  external_id TEXT,
  attempt_started_at TEXT,
  sent_at TEXT,
  claimed_until TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(status NOT IN ('pending','sending') OR body IS NOT NULL),
  CHECK(status <> 'sent' OR (external_id IS NOT NULL AND sent_at IS NOT NULL)),
  CHECK(status NOT IN ('sent','cancelled','expired','abandoned') OR finished_at IS NOT NULL)
);

CREATE INDEX inbox_pending_idx ON inbox(status, received_at);
CREATE INDEX events_pending_idx ON events(status, created_at);
CREATE INDEX events_item_idx ON events(item_key, created_at);
CREATE INDEX outbox_due_idx ON outbox(status, scheduled_at);
CREATE INDEX outbox_budget_idx ON outbox(business_date, counts_as_proactive, status);

COMMIT;

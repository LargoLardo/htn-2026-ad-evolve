-- Run bodies live in Durable Objects. Every index and query is tenant scoped.
CREATE TABLE runs (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  product TEXT NOT NULL,
  status TEXT NOT NULL,
  stage TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (account_id, id)
);
CREATE INDEX runs_by_account_date ON runs(account_id, created_at DESC);
CREATE TABLE maps (
  account_id TEXT NOT NULL,
  media_hash TEXT NOT NULL,
  run_id TEXT NOT NULL,
  artifact_key TEXT NOT NULL,
  built_at TEXT NOT NULL,
  PRIMARY KEY (account_id, media_hash)
);
CREATE INDEX maps_by_account_run ON maps(account_id, run_id);

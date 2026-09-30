CREATE TABLE IF NOT EXISTS captures (
  request_id TEXT PRIMARY KEY,
  session_id TEXT,
  account_uuid TEXT,
  device_id TEXT,
  cc_version TEXT,
  cc_entrypoint TEXT,
  cc_config_hash TEXT,
  timestamp INTEGER NOT NULL,
  duration_ms INTEGER,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  model TEXT,
  is_streaming INTEGER,
  status_code INTEGER,
  error TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  system_blocks INTEGER,
  message_count INTEGER,
  tool_count INTEGER,
  request_body_path TEXT NOT NULL,
  response_body_path TEXT,
  request_body_bytes INTEGER NOT NULL,
  response_body_bytes INTEGER,
  source TEXT -- 'proxy' | 'otel'; NULL on rows written before the column existed (proxy)
);

CREATE INDEX IF NOT EXISTS idx_captures_session   ON captures(session_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_captures_timestamp ON captures(timestamp DESC);

-- OTel ingester: session-log failure events already recorded as a capture,
-- so a restart doesn't attribute them again.
CREATE TABLE IF NOT EXISTS otel_failures (
  event_uuid TEXT PRIMARY KEY,
  request_id TEXT NOT NULL
);

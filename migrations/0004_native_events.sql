CREATE TABLE event_subscriptions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  auth_version INTEGER NOT NULL,
  oauth_grant_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL,
  name TEXT NOT NULL,
  arguments_json TEXT NOT NULL,
  callback_url TEXT NOT NULL,
  signing_secret TEXT NOT NULL,
  previous_secret TEXT,
  previous_until INTEGER,
  verified_at INTEGER NOT NULL,
  verification_token TEXT,
  expires_at INTEGER NOT NULL,
  scanned_at INTEGER NOT NULL DEFAULT 0,
  disabled_at INTEGER
);
CREATE INDEX event_subscription_agent ON event_subscriptions(agent_id, expires_at);
CREATE TABLE event_deliveries (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES event_subscriptions(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  body_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  delivered_at INTEGER,
  failed_at INTEGER,
  http_status INTEGER
);
CREATE INDEX event_delivery_due ON event_deliveries(next_attempt_at, delivered_at, failed_at);
CREATE TABLE native_receivers (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  auth_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  task_reference TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

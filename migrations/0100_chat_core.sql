PRAGMA foreign_keys = ON;

-- v2 baseline: long-lived chats with per-owner send permissions. Numbered 0100 so it
-- can never be mistaken for an already-applied v1 migration (0001-0005).

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL,
  transports_json TEXT NOT NULL,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX passkeys_user ON passkeys(user_id);

CREATE TABLE auth_challenges (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('register', 'login', 'add_passkey', 'recover')),
  challenge TEXT NOT NULL,
  data_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE browser_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  csrf_hash TEXT NOT NULL,
  authenticated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX browser_sessions_user ON browser_sessions(user_id);

CREATE TABLE recovery_links (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK(platform IN ('dot', 'muse', 'duet')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'revoked')),
  auth_version INTEGER NOT NULL DEFAULT 1,
  oauth_client_id TEXT,
  authorized_at INTEGER,
  last_seen_at INTEGER,
  reset_pending INTEGER NOT NULL DEFAULT 0,
  connection_changed_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX agents_owner ON agents(owner_id);
CREATE TRIGGER agent_owner_immutable BEFORE UPDATE OF owner_id, platform ON agents
WHEN NEW.owner_id <> OLD.owner_id OR NEW.platform <> OLD.platform
BEGIN SELECT RAISE(ABORT, 'agent owner and platform are immutable'); END;

CREATE TABLE contact_invites (
  token_hash TEXT PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  inviter_id TEXT NOT NULL REFERENCES users(id),
  inviter_agent_id TEXT REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT REFERENCES users(id),
  consumed_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX contact_invites_inviter ON contact_invites(inviter_id);

-- Owner IDs are stored sorted so a pair of owners has exactly one row.
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  owner_low TEXT NOT NULL REFERENCES users(id),
  owner_high TEXT NOT NULL REFERENCES users(id),
  blocked_by_low_at INTEGER,
  blocked_by_high_at INTEGER,
  created_at INTEGER NOT NULL,
  removed_at INTEGER,
  CHECK (owner_low < owner_high),
  UNIQUE(owner_low, owner_high)
);

-- "I expose this Agent to this contact." Each row belongs to the Agent's owner.
CREATE TABLE contact_agents (
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(contact_id, agent_id)
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  agent_low TEXT NOT NULL REFERENCES agents(id),
  agent_high TEXT NOT NULL REFERENCES agents(id),
  same_owner INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'open', 'closed')),
  requested_by TEXT REFERENCES users(id),
  requested_at INTEGER,
  close_reason TEXT,
  closed_by TEXT,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  CHECK (agent_low < agent_high),
  UNIQUE(agent_low, agent_high)
);

CREATE TABLE chat_sides (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  auto_until INTEGER,
  auto_left INTEGER NOT NULL DEFAULT 0,
  paused_at INTEGER,
  cleared_before INTEGER NOT NULL DEFAULT 0,
  delivered_seq INTEGER NOT NULL DEFAULT 0,
  last_request_at INTEGER,
  PRIMARY KEY(chat_id, agent_id)
);
CREATE INDEX chat_sides_owner ON chat_sides(owner_id);
CREATE INDEX chat_sides_agent ON chat_sides(agent_id);

-- seq is the real send order; drafts get a seq only when approved.
CREATE TABLE messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_kind TEXT NOT NULL CHECK(sender_kind IN ('agent', 'owner')),
  sender_agent_id TEXT REFERENCES agents(id),
  sender_owner_id TEXT REFERENCES users(id),
  reply_to TEXT,
  idempotency_key TEXT,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  sent_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  withheld_at INTEGER,
  CHECK ((sender_kind = 'agent') = (sender_agent_id IS NOT NULL)),
  UNIQUE(sender_agent_id, idempotency_key)
);
CREATE INDEX messages_chat ON messages(chat_id, seq);
CREATE INDEX messages_expiry ON messages(expires_at);
-- Sent content is immutable; only withholding and key rotation (new key_version) may change.
CREATE TRIGGER message_content_immutable BEFORE UPDATE ON messages
WHEN NEW.id IS NOT OLD.id OR NEW.chat_id IS NOT OLD.chat_id OR NEW.sender_kind IS NOT OLD.sender_kind
  OR NEW.sender_agent_id IS NOT OLD.sender_agent_id OR NEW.sender_owner_id IS NOT OLD.sender_owner_id
  OR NEW.reply_to IS NOT OLD.reply_to OR NEW.sent_at IS NOT OLD.sent_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (NEW.ciphertext IS NOT OLD.ciphertext AND NEW.key_version = OLD.key_version)
  OR (OLD.withheld_at IS NOT NULL AND NEW.withheld_at IS NOT OLD.withheld_at)
BEGIN SELECT RAISE(ABORT, 'sent messages are immutable'); END;

CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  reply_to TEXT,
  idempotency_key TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  hold_reason TEXT NOT NULL CHECK(hold_reason IN ('review', 'dlp')),
  dlp_rules TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'expired')),
  message_id TEXT,
  decided_by TEXT REFERENCES users(id),
  decided_at INTEGER,
  result_seen_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  UNIQUE(agent_id, idempotency_key)
);
CREATE INDEX drafts_chat ON drafts(chat_id, status);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  seen_at INTEGER
);
CREATE INDEX notifications_owner ON notifications(owner_id, seen_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  owner_id TEXT,
  agent_id TEXT,
  entity_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_owner ON audit_events(owner_id, created_at);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT, 'audit events are append-only'); END;

CREATE TABLE rate_limits (
  key_hash TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(key_hash, bucket)
);
CREATE INDEX rate_limit_expiry ON rate_limits(expires_at);

CREATE TABLE oauth_records (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX oauth_record_expiry ON oauth_records(expires_at);

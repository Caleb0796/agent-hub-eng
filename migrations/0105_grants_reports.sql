-- What an owner handed to their Agent. Information for the Agent, never a Hub permission:
-- policy.ts does not read this table. A NULL chat_id applies to every chat and has no expiry.
CREATE TABLE agent_grants (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT REFERENCES chats(id),
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  -- A Hub-run Agent starts on a new task at once; NULL until it has had its turn.
  acted_at INTEGER
);
CREATE INDEX agent_grants_agent ON agent_grants(agent_id, chat_id);
CREATE INDEX agent_grants_expiry ON agent_grants(expires_at);

-- What an Agent tells only its own owner. Not a message, so it is never delivered to the other side.
CREATE TABLE agent_reports (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  owner_id TEXT NOT NULL REFERENCES users(id),
  chat_id TEXT NOT NULL REFERENCES chats(id),
  idempotency_key TEXT NOT NULL,
  needs_owner INTEGER NOT NULL DEFAULT 0,
  ciphertext TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  read_at INTEGER,
  UNIQUE(agent_id, idempotency_key)
);
CREATE INDEX agent_reports_owner ON agent_reports(owner_id, created_at);
CREATE INDEX agent_reports_expiry ON agent_reports(expires_at);

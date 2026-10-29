PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  signing_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disabled_at INTEGER
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
  kind TEXT NOT NULL CHECK(kind IN ('register', 'login')),
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

CREATE TABLE signup_invites (
  token_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_by TEXT REFERENCES users(id)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id),
  platform TEXT NOT NULL CHECK(platform IN ('dot', 'muse')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('awaiting_connection', 'awaiting_endpoint', 'awaiting_claim', 'awaiting_confirmation', 'active', 'revoked')),
  age_key TEXT,
  signing_key TEXT,
  fingerprint TEXT,
  generation INTEGER NOT NULL DEFAULT 1,
  auth_version INTEGER NOT NULL DEFAULT 1,
  claim_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK ((age_key IS NULL) = (signing_key IS NULL))
);
CREATE INDEX agents_owner ON agents(owner_id);

CREATE TABLE enrollments (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  nonce TEXT NOT NULL,
  proof_json TEXT,
  claim_payload_json TEXT,
  expires_at INTEGER NOT NULL
);

CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  owner_a TEXT NOT NULL REFERENCES users(id),
  agent_a TEXT NOT NULL REFERENCES agents(id),
  owner_b TEXT REFERENCES users(id),
  agent_b TEXT REFERENCES agents(id),
  status TEXT NOT NULL CHECK(status IN ('invited', 'confirming', 'awaiting_endpoints', 'active', 'revoked', 'expired')),
  invite_hash TEXT NOT NULL UNIQUE,
  descriptor_json TEXT,
  fingerprint TEXT,
  approval_a_json TEXT,
  approval_b_json TEXT,
  endpoint_a_ack TEXT,
  endpoint_b_ack TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (owner_b IS NULL OR owner_a <> owner_b),
  CHECK (agent_b IS NULL OR agent_a <> agent_b)
);
CREATE INDEX pairings_owner_a ON pairings(owner_a);
CREATE INDEX pairings_owner_b ON pairings(owner_b);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  pairing_id TEXT NOT NULL REFERENCES pairings(id),
  initiator_agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK(status IN ('awaiting_approval', 'authorized', 'ready', 'active', 'closed', 'revoked', 'expired')),
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL UNIQUE,
  approval_a_json TEXT,
  approval_b_json TEXT,
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 60 AND 600),
  max_messages INTEGER NOT NULL CHECK(max_messages BETWEEN 2 AND 64),
  message_count INTEGER NOT NULL DEFAULT 0,
  last_sender TEXT,
  last_message_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER,
  deadline INTEGER,
  closed_at INTEGER,
  close_reason TEXT,
  CHECK (message_count BETWEEN 0 AND max_messages),
  CHECK ((started_at IS NULL) = (deadline IS NULL))
);
CREATE INDEX conversations_pairing ON conversations(pairing_id);

CREATE TABLE readiness (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  nonce TEXT NOT NULL,
  proof_json TEXT,
  native_context_json TEXT,
  ready_at INTEGER,
  cleanup_status TEXT NOT NULL DEFAULT 'not_started' CHECK(cleanup_status IN ('not_started', 'required', 'reported_complete', 'failed')),
  cleanup_proof_json TEXT,
  PRIMARY KEY(conversation_id, agent_id)
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  position INTEGER NOT NULL,
  sender_id TEXT NOT NULL REFERENCES agents(id),
  recipient_id TEXT NOT NULL REFERENCES agents(id),
  sender_sequence INTEGER NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  idempotency_key TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  ciphertext_bytes INTEGER NOT NULL,
  accepted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  delivered_at INTEGER,
  receipt_json TEXT,
  UNIQUE(conversation_id, position),
  UNIQUE(conversation_id, sender_id, sender_sequence),
  UNIQUE(conversation_id, sender_id, idempotency_key)
);
CREATE INDEX messages_inbox ON messages(conversation_id, recipient_id, position);

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

CREATE TRIGGER agent_binding_immutable BEFORE UPDATE ON agents
WHEN NEW.owner_id <> OLD.owner_id OR NEW.platform <> OLD.platform OR NEW.generation <> OLD.generation
  OR (OLD.signing_key IS NOT NULL AND (NEW.signing_key IS NOT OLD.signing_key OR NEW.age_key IS NOT OLD.age_key OR NEW.fingerprint IS NOT OLD.fingerprint))
BEGIN SELECT RAISE(ABORT, 'agent identity is immutable; revoke and enroll a new identity'); END;
CREATE TRIGGER owner_signing_key_immutable BEFORE UPDATE OF signing_key ON users
WHEN NEW.signing_key IS NOT OLD.signing_key
BEGIN SELECT RAISE(ABORT, 'owner key changes require a separate recovery ceremony'); END;
CREATE TRIGGER pair_descriptor_immutable BEFORE UPDATE OF descriptor_json,fingerprint ON pairings
WHEN OLD.descriptor_json IS NOT NULL AND (NEW.descriptor_json IS NOT OLD.descriptor_json OR NEW.fingerprint IS NOT OLD.fingerprint)
BEGIN SELECT RAISE(ABORT, 'pairing descriptor is immutable'); END;
CREATE TRIGGER conversation_policy_immutable BEFORE UPDATE OF policy_json,policy_hash,pairing_id,initiator_agent_id,duration_seconds,max_messages,expires_at ON conversations
WHEN NEW.policy_json IS NOT OLD.policy_json OR NEW.policy_hash IS NOT OLD.policy_hash OR NEW.pairing_id IS NOT OLD.pairing_id
  OR NEW.initiator_agent_id IS NOT OLD.initiator_agent_id OR NEW.duration_seconds <> OLD.duration_seconds
  OR NEW.max_messages <> OLD.max_messages OR NEW.expires_at <> OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'conversation authorization is immutable'); END;
CREATE TRIGGER conversation_clock_no_extension BEFORE UPDATE OF started_at,deadline ON conversations
WHEN OLD.started_at IS NOT NULL AND (NEW.started_at IS NOT OLD.started_at OR NEW.deadline IS NOT OLD.deadline)
BEGIN SELECT RAISE(ABORT, 'active conversation clock cannot be changed'); END;

CREATE TRIGGER message_guard BEFORE INSERT ON messages
WHEN NOT EXISTS (
  SELECT 1 FROM conversations c JOIN pairings p ON p.id=c.pairing_id
    JOIN agents a ON a.id=p.agent_a JOIN agents b ON b.id=p.agent_b
  WHERE c.id=NEW.conversation_id AND c.status IN ('ready','active') AND p.status='active'
    AND a.status='active' AND b.status='active'
    AND a.generation=json_extract(c.policy_json,'$.participants[0].generation')
    AND b.generation=json_extract(c.policy_json,'$.participants[1].generation')
    AND c.approval_a_json IS NOT NULL AND c.approval_b_json IS NOT NULL
    AND EXISTS(SELECT 1 FROM readiness r WHERE r.conversation_id=c.id AND r.agent_id=p.agent_a AND r.ready_at IS NOT NULL)
    AND EXISTS(SELECT 1 FROM readiness r WHERE r.conversation_id=c.id AND r.agent_id=p.agent_b AND r.ready_at IS NOT NULL)
    AND ((NEW.sender_id=p.agent_a AND NEW.recipient_id=p.agent_b) OR (NEW.sender_id=p.agent_b AND NEW.recipient_id=p.agent_a))
    AND c.message_count<c.max_messages AND NEW.position=c.message_count+1
    AND NEW.accepted_at>=c.created_at AND NEW.accepted_at<c.expires_at
    AND (c.deadline IS NULL OR NEW.accepted_at<c.deadline)
    AND NEW.expires_at>NEW.accepted_at AND NEW.expires_at<=MIN(c.expires_at,NEW.accepted_at+900)
    AND NEW.ciphertext_bytes BETWEEN 100 AND 32768
    AND ((c.message_count=0 AND NEW.sender_id=c.initiator_agent_id AND NEW.reply_to IS NULL)
      OR (c.message_count>0 AND c.started_at IS NOT NULL AND NEW.sender_id<>c.last_sender AND NEW.reply_to=c.last_message_id))
    AND NEW.sender_sequence>COALESCE((SELECT MAX(m.sender_sequence) FROM messages m WHERE m.conversation_id=c.id AND m.sender_id=NEW.sender_id),0)
)
BEGIN SELECT RAISE(ABORT, 'message not authorized or conversation state changed'); END;

CREATE TRIGGER message_accepted AFTER INSERT ON messages BEGIN
  UPDATE conversations SET message_count=message_count+1,last_sender=NEW.sender_id,last_message_id=NEW.id,
    status=CASE WHEN message_count+1>=max_messages THEN 'closed' ELSE status END,
    close_reason=CASE WHEN message_count+1>=max_messages THEN 'message_limit' ELSE close_reason END,
    closed_at=CASE WHEN message_count+1>=max_messages THEN NEW.accepted_at ELSE closed_at END
    WHERE id=NEW.conversation_id;
  INSERT INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at)
    VALUES('accepted:'||NEW.id,'ciphertext_accepted',NULL,NEW.sender_id,NEW.conversation_id,
      json_object('message_id',NEW.id,'envelope_hash',NEW.envelope_hash,'position',NEW.position,'ciphertext_bytes',NEW.ciphertext_bytes),NEW.accepted_at);
END;

CREATE TRIGGER message_content_immutable BEFORE UPDATE ON messages
WHEN NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id OR NEW.position<>OLD.position
  OR NEW.sender_id IS NOT OLD.sender_id OR NEW.recipient_id IS NOT OLD.recipient_id OR NEW.sender_sequence<>OLD.sender_sequence
  OR NEW.reply_to IS NOT OLD.reply_to OR NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.envelope_json IS NOT OLD.envelope_json
  OR NEW.envelope_hash IS NOT OLD.envelope_hash OR NEW.ciphertext_bytes<>OLD.ciphertext_bytes
  OR NEW.accepted_at<>OLD.accepted_at OR NEW.expires_at<>OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'accepted message content is immutable'); END;

CREATE TRIGGER message_delivered AFTER UPDATE OF delivered_at ON messages
WHEN OLD.delivered_at IS NULL AND NEW.delivered_at IS NOT NULL BEGIN
  INSERT OR IGNORE INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at)
    VALUES('delivered:'||NEW.id,'ciphertext_delivered',NULL,NEW.recipient_id,NEW.conversation_id,
      json_object('message_id',NEW.id,'position',NEW.position),NEW.delivered_at);
END;

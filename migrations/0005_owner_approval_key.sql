PRAGMA foreign_keys = ON;

-- 'browser': random key held only in one browser's IndexedDB.
-- 'passkey-prf': derived from a (possibly synced) passkey's PRF output, so any device
-- holding that passkey re-derives the same approval key.
ALTER TABLE users ADD COLUMN approval_key_kind TEXT NOT NULL DEFAULT 'browser'
  CHECK(approval_key_kind IN ('browser', 'passkey-prf'));
ALTER TABLE users ADD COLUMN approval_credential_id TEXT;

-- An owner key may only change before anything has pinned it: no unrevoked Agent
-- (endpoints pin owner_key at prepare) and no live pairing descriptor.
DROP TRIGGER owner_signing_key_immutable;
CREATE TRIGGER owner_signing_key_guarded BEFORE UPDATE OF signing_key ON users
WHEN NEW.signing_key IS NOT OLD.signing_key AND (
  EXISTS(SELECT 1 FROM agents WHERE owner_id = OLD.id AND status <> 'revoked')
  OR EXISTS(SELECT 1 FROM pairings WHERE (owner_a = OLD.id OR owner_b = OLD.id) AND status NOT IN ('revoked', 'expired'))
)
BEGIN SELECT RAISE(ABORT, 'owner key is pinned by an Agent or pairing; revoke them first'); END;

-- Agents the Hub runs itself by calling a model, instead of waiting for a platform to fetch.
ALTER TABLE agents ADD COLUMN runner TEXT NOT NULL DEFAULT 'platform' CHECK(runner IN ('platform', 'hub'));
ALTER TABLE agents ADD COLUMN run_lease_until INTEGER;
ALTER TABLE agents ADD COLUMN run_retry_at INTEGER;
ALTER TABLE agents ADD COLUMN run_error TEXT;
-- Taken is not handled: a failed model call must not lose the owner's instruction.
ALTER TABLE chat_sides ADD COLUMN handled_seq INTEGER NOT NULL DEFAULT 0;

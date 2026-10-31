-- A second consumption aborts the whole acceptance batch, so the losing side of a race
-- leaves no contact, exposure or chat behind.
CREATE TRIGGER invite_single_use BEFORE UPDATE OF consumed_at ON contact_invites
WHEN OLD.consumed_at IS NOT NULL OR OLD.revoked_at IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'invite_spent'); END;

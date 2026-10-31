-- withheld_at also covers messages held back when a chat closes, which both owners may still
-- read. withdrawn_at marks only an owner's explicit withdrawal.
ALTER TABLE messages ADD COLUMN withdrawn_at INTEGER;

-- Agents send directly by default; an owner may ask to see their Agent's sends first, per chat.
-- auto_until and auto_left stay unused so a rollback to the previous deployment keeps working.
ALTER TABLE chat_sides ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0;

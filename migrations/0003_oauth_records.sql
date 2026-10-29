CREATE TABLE oauth_records (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
);
CREATE INDEX oauth_record_expiry ON oauth_records(expires_at);

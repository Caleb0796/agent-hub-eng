CREATE UNIQUE INDEX conversations_one_open_pair ON conversations(pairing_id)
  WHERE status IN ('awaiting_approval','authorized','ready','active');

CREATE TRIGGER conversation_closed_event AFTER UPDATE OF status ON conversations
WHEN OLD.status<>NEW.status AND NEW.status IN ('closed','revoked','expired') BEGIN
  INSERT OR IGNORE INTO audit_events(id,event_type,owner_id,agent_id,entity_id,metadata_json,created_at)
    VALUES('state:'||NEW.id||':'||NEW.status,'conversation_'||NEW.status,NULL,NULL,NEW.id,
      json_object('reason',NEW.close_reason,'message_count',NEW.message_count),COALESCE(NEW.closed_at,NEW.deadline,NEW.expires_at));
END;

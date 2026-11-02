import { useEffect, useState } from 'react';
import { api } from '../api';
import { when } from '../ui';

type Event = { id: string; event_type: string; entity_id: string; created_at: number };
const labels: Record<string, string> = {
  owner_registered: 'Signed up',
  owner_authenticated: 'Logged in',
  passkey_added: 'Passkey added',
  owner_recovered: 'Account recovered with a recovery link',
  agent_created: 'Agent created',
  connector_authorized: 'Agent connection authorized',
  agent_connection_reset: 'Agent connection reset',
  agent_retired: 'Agent retired',
  invite_created: 'Invite created',
  contact_added: 'Friend added',
  agent_exposed: 'Agent shared with a friend',
  agent_unexposed: 'Agent no longer shared',
  contact_blocked: 'Friend blocked',
  contact_unblocked: 'Friend unblocked',
  contact_removed: 'Friend removed',
  chat_requested: 'Chat requested',
  chat_approved: 'Chat approved',
  chat_opened: 'Chat opened',
  chat_closed: 'Chat closed',
  chat_paused: 'Chat paused',
  chat_resumed: 'Chat resumed',
  window_opened: 'Auto window opened',
  window_closed: 'Auto window closed',
  draft_approved: 'Draft approved',
  draft_rejected: 'Draft rejected',
  dlp_hold: 'Possible secret held back',
  message_withdrawn: 'Message withdrawn',
  account_deleted: 'Account deleted',
};

export function ActivityPage({ version }: { version: unknown }) {
  const [events, setEvents] = useState<Event[] | null>(null);
  useEffect(() => {
    void api<{ events: Event[] }>('/api/audit').then((v) => setEvents(v.events));
  }, [version]);
  if (!events) return <div className="skeleton" />;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ACTIVITY</span>
          <h1>Activity</h1>
          <p className="muted">
            Permission changes and actions that involve you. Records do not include message text.
          </p>
        </div>
      </div>
      <section className="panel">
        {events.map((e) => (
          <div className="list-row" key={e.id}>
            <div />
            <div>{labels[e.event_type] ?? e.event_type}</div>
            <span className="muted">{when(e.created_at)}</span>
          </div>
        ))}
      </section>
    </>
  );
}

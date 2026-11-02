import { useEffect, useState } from 'react';
import { Check, ShieldAlert, X } from 'lucide-react';
import { api, navigate } from '../api';
import type { ReviewItem, Run } from '../types';
import { Empty, when } from '../ui';

export function ReviewPage({ run, busy, version }: { run: Run; busy: boolean; version: unknown }) {
  const [items, setItems] = useState<ReviewItem[] | null>(null);
  const load = () => api<{ drafts: ReviewItem[] }>('/api/review').then((v) => setItems(v.drafts));
  useEffect(() => {
    void load();
  }, [version]);
  if (!items) return <div className="skeleton" />;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">REVIEW</span>
          <h1>Awaiting review</h1>
          <p className="muted">
            These are messages your Agent wants to send. Only this page ({location.origin}
            /review) is the real place to review them.
          </p>
        </div>
      </div>
      {!items.length ? (
        <Empty icon={<Check size={22} />} title="No messages awaiting review">
          New messages your Agent wants to send will appear here.
        </Empty>
      ) : (
        items.map((d) => (
          <section className="panel" key={d.id}>
            <p className="muted">
              {d.agent_label} → {d.peer_label} · {when(d.created_at)} · Decide by{' '}
              {when(d.expires_at)}
            </p>
            {d.hold_reason === 'dlp' && (
              <div className="error">
                <ShieldAlert size={16} /> Possible secret: {d.dlp_rules.join(', ')}. Send only if
                you are sure it is safe.
              </div>
            )}
            <div className="message draft">{d.text}</div>
            <div className="button-row">
              <button
                className="button primary compact"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/api/drafts/${d.id}/approve`, 'POST');
                    await load();
                  })
                }
              >
                <Check size={15} /> Send
              </button>
              <button
                className="button secondary compact"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await api(`/api/drafts/${d.id}/reject`, 'POST');
                    await load();
                  })
                }
              >
                <X size={15} /> Reject
              </button>
              <button className="text-button" onClick={() => navigate(`/chats/${d.chat_id}`)}>
                View chat
              </button>
            </div>
          </section>
        ))
      )}
    </>
  );
}

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
          <h1>Awaiting review</h1>
          <p className="muted">
            Messages your Agent wants to send that you need to see first. Only this page (
            {location.origin}
            /review) is the real place to review them.
          </p>
        </div>
      </div>
      {!items.length ? (
        <Empty icon={<Check size={22} />} title="No messages awaiting review">
          Messages that look like they contain a secret, and messages from chats you set to review
          first, appear here.
        </Empty>
      ) : (
        items.map((d) => (
          <section className="panel" key={d.id}>
            <p className="review-meta">
              {d.agent_label} wants to send this to {d.peer_label}. Decide by {when(d.expires_at)}
            </p>
            {d.hold_reason === 'dlp' && (
              <div className="error">
                <ShieldAlert size={16} /> Possible secret: {d.dlp_rules.join(', ')}. Send only if
                you are sure it is safe.
              </div>
            )}
            <div className="review-text">{d.text}</div>
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
                <X size={15} /> Discard
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

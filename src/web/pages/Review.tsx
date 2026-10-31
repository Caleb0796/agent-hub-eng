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
          <h1>待审核</h1>
          <p className="muted">
            这些是你的 Agent 想发出的消息。只有这个页面（{location.origin}
            /review）是真正的审核入口。
          </p>
        </div>
      </div>
      {!items.length ? (
        <Empty icon={<Check size={22} />} title="没有待审核的消息">
          Agent 发出的新消息会出现在这里。
        </Empty>
      ) : (
        items.map((d) => (
          <section className="panel" key={d.id}>
            <p className="muted">
              {d.agent_label} → {d.peer_label} · {when(d.created_at)} · {when(d.expires_at)} 前处理
            </p>
            {d.hold_reason === 'dlp' && (
              <div className="error">
                <ShieldAlert size={16} /> 疑似包含密钥：{d.dlp_rules.join('、')}。确认无误才发送。
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
                <Check size={15} /> 发送
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
                <X size={15} /> 拒绝
              </button>
              <button className="text-button" onClick={() => navigate(`/chats/${d.chat_id}`)}>
                查看聊天
              </button>
            </div>
          </section>
        ))
      )}
    </>
  );
}

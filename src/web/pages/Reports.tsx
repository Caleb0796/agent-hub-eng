import { useEffect, useState } from 'react';
import { CircleCheck, MessageCircleQuestion } from 'lucide-react';
import { api, navigate } from '../api';
import { Empty, when } from '../ui';

type Report = {
  id: string;
  chat_id: string;
  agent_label: string;
  peer_label: string;
  text: string;
  needs_owner: boolean;
  read: boolean;
  created_at: number;
};

/** What Agents got done, so nobody has to read the whole conversation to find out. */
export function ReportsPage({ version }: { version: unknown }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  useEffect(() => {
    void api<{ reports: Report[] }>('/api/reports').then((v) => {
      setReports(v.reports);
      if (v.reports.some((r) => !r.read)) void api('/api/reports/read', 'POST');
    });
  }, [version]);
  if (!reports) return <div className="skeleton" />;
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>结果</h1>
          <p>你的 Agent 办好的事和要问你的问题。只有你能看到。</p>
        </div>
      </div>
      {!reports.length ? (
        <Empty icon={<CircleCheck size={22} />} title="还没有结果">
          交给 Agent 一件事，它办好后会告诉你。
        </Empty>
      ) : (
        <section className="section">
          {reports.map((r) => (
            <button
              className="row report-row"
              key={r.id}
              onClick={() => navigate(`/chats/${r.chat_id}`)}
            >
              {r.needs_owner ? <MessageCircleQuestion size={18} /> : <CircleCheck size={18} />}
              <span className="row-main">
                <strong>{r.text}</strong>
                <small>
                  {r.agent_label}，和 {r.peer_label} 的聊天，{when(r.created_at)}
                </small>
              </span>
            </button>
          ))}
        </section>
      )}
    </>
  );
}

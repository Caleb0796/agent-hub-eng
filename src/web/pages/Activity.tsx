import { useEffect, useState } from 'react';
import { api } from '../api';
import { when } from '../ui';

type Event = { id: string; event_type: string; entity_id: string; created_at: number };
const labels: Record<string, string> = {
  owner_registered: '注册账号',
  owner_authenticated: '登录',
  passkey_added: '添加通行密钥',
  owner_recovered: '通过恢复链接找回账号',
  agent_created: '新建 Agent',
  connector_authorized: 'Agent 授权连接',
  agent_connection_reset: '重置 Agent 连接',
  agent_retired: '退役 Agent',
  invite_created: '生成邀请',
  contact_added: '添加好友',
  agent_exposed: '向好友开放 Agent',
  agent_unexposed: '收回 Agent 开放',
  contact_blocked: '拉黑',
  contact_unblocked: '解除拉黑',
  contact_removed: '删除好友',
  chat_requested: '请求聊天',
  chat_approved: '同意聊天',
  chat_opened: '聊天开启',
  chat_closed: '聊天关闭',
  chat_paused: '暂停聊天',
  chat_resumed: '解除暂停',
  review_on: '打开发出前确认',
  review_off: '关闭发出前确认',
  window_opened: '打开自动窗口',
  window_closed: '关闭自动窗口',
  draft_approved: '批准草稿',
  draft_rejected: '拒绝草稿',
  dlp_hold: '扣留疑似密钥',
  message_withdrawn: '撤回消息',
  account_deleted: '注销账号',
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
          <h1>活动记录</h1>
          <p className="muted">与你相关的权限变化和操作。记录不包含消息正文。</p>
        </div>
      </div>
      <section className="section">
        {events.map((e) => (
          <div className="log-row" key={e.id}>
            <span>{labels[e.event_type] ?? e.event_type}</span>
            <time>{when(e.created_at)}</time>
          </div>
        ))}
      </section>
    </>
  );
}

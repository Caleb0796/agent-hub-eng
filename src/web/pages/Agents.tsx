import { useEffect, useState } from 'react';
import {
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
} from '@simplewebauthn/browser';
import { Fingerprint, Plus, RefreshCw, Sparkles, Trash2, Unplug, X } from 'lucide-react';
import { api, navigate } from '../api';
import type { Dashboard, Run } from '../types';
import { Avatar, Badge, CopyButton, Empty, platformName, runErrorText, when } from '../ui';

const musePrompt = (origin: string) =>
  `请按 ${origin}/connect/muse 的说明，把你连接到我的 Agent Hub。使用官方连接器和安全凭证存储，授权页由我本人确认；连接后先调用 hub_whoami。`;

/** The default way to get an Agent: nothing to install, connect or configure. */
export function CreateAgent({
  run,
  busy,
  onCreated,
  label = '创建我的 Agent',
}: {
  run: Run;
  busy: boolean;
  onCreated?: (id: string) => Promise<void> | void;
  label?: string;
}) {
  return (
    <>
      <button
        className="button primary"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            const agent = await api<{ id: string }>('/api/agents/hub', 'POST', {});
            await onCreated?.(agent.id);
          })
        }
      >
        <Sparkles size={16} /> {label}
      </button>
      <p className="fine-print">
        它由 Muse Spark 驱动，不用安装。消息会发给 Meta 的模型来生成回复。
      </p>
    </>
  );
}

/** Things an Agent should always remember, used in every chat. */
function StandingNotes({ agentId, run, busy }: { agentId: string; run: Run; busy: boolean }) {
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]),
    [text, setText] = useState('');
  const load = () =>
    api<{ grants: { id: string; text: string }[] }>(`/api/agents/${agentId}/grants`).then((v) =>
      setNotes(v.grants),
    );
  useEffect(() => {
    void load();
  }, [agentId]);
  return (
    <div className="notes">
      <small>它应该一直记住的事（只有你和它能看到）</small>
      {notes.map((n) => (
        <div className="note" key={n.id}>
          <span>{n.text}</span>
          <button
            className="icon-button"
            aria-label="删除这一条"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`/api/grants/${n.id}`, 'DELETE');
                await load();
              })
            }
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api(`/api/agents/${agentId}/grants`, 'POST', { text });
            setText('');
            await load();
          });
        }}
      >
        <input
          aria-label="添加要记住的事"
          placeholder="比如：我不吃辣，工作日 7 点后才有空"
          maxLength={1000}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button className="button secondary compact" disabled={busy || !text.trim()}>
          记住
        </button>
      </form>
    </div>
  );
}

/** One screen of instructions for the current platform. */
export function ConnectGuide() {
  const [platform, setPlatform] = useState<'dot' | 'muse' | 'duet'>('dot');
  const origin = location.origin;
  return (
    <section className="section">
      <h2>连接新的 Agent</h2>
      <div className="segmented">
        {(['dot', 'muse', 'duet'] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={platform === p ? 'selected' : ''}
            onClick={() => setPlatform(p)}
          >
            {platformName(p)}
          </button>
        ))}
      </div>
      {platform === 'muse' ? (
        <>
          <p className="muted">把这句话发给你的 Muse，它会自己准备连接，然后打开授权页让你确认。</p>
          <div className="prompt-box">{musePrompt(origin)}</div>
          <CopyButton value={musePrompt(origin)} label="复制给 Muse 的话" />
        </>
      ) : (
        <>
          <p className="muted">
            在 {platform === 'dot' ? 'ChatGPT' : 'Claude'}{' '}
            的连接器设置里添加自定义连接器，地址填下面这个，认证选 OAuth。平台会打开 Agent Hub
            的授权页，你点“授权连接”即可。
          </p>
          <div className="prompt-box mono">{origin}/mcp</div>
          <CopyButton value={`${origin}/mcp`} label="复制连接地址" />
          {platform === 'duet' && (
            <p className="fine-print">Duet 的授权回调尚在真机验证中，暂时可能无法完成连接。</p>
          )}
        </>
      )}
      <p className="fine-print">
        授权完成显示“已授权”；Agent 第一次调用工具后显示“已上线”。平台自己的确认卡片需要你在原生 App
        里处理。
        <a href={`/connect/${platform}`}> 完整说明</a>
      </p>
    </section>
  );
}

export function AgentsPage({ data, run, busy }: { data: Dashboard; run: Run; busy: boolean }) {
  const [renaming, setRenaming] = useState<string | null>(null),
    [label, setLabel] = useState('');
  const agents = data.agents.filter((a) => a.status === 'active'),
    retired = data.agents.filter((a) => a.status !== 'active');
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>我的 Agent</h1>
          <p>它们替你聊天做事，但不能替你加好友或改设置。</p>
        </div>
      </div>
      {!agents.length &&
        (data.hub_runner ? (
          <section className="panel">
            <h2>给自己创建一个 Agent</h2>
            <p className="muted">它会替你和朋友、朋友的 Agent 聊天，帮你把事情办了。</p>
            <CreateAgent run={run} busy={busy} onCreated={() => navigate('/contacts')} />
          </section>
        ) : (
          <Empty icon={<Plus size={22} />} title="还没有连接 Agent">
            按下面的说明连接第一个 Agent。
          </Empty>
        ))}
      {agents.length > 0 && (
        <section className="section">
          {agents.map((a) => (
            <div key={a.id}>
              <div className="row">
                <Avatar kind="agent" name={a.label} platform={a.platform} />
                <div className="row-main">
                  {renaming === a.id ? (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await api(`/api/agents/${a.id}/rename`, 'POST', { label });
                          setRenaming(null);
                        });
                      }}
                    >
                      <input
                        aria-label="新名字"
                        value={label}
                        maxLength={60}
                        onChange={(e) => setLabel(e.target.value)}
                      />
                      <button className="button primary compact" disabled={busy}>
                        保存
                      </button>
                    </form>
                  ) : (
                    <strong>{a.label}</strong>
                  )}
                  <small>
                    {a.runner === 'hub'
                      ? runErrorText(a.run_error) || '由 Hub 调用 Muse Spark 代你回复'
                      : `${platformName(a.platform)}，最近活动 ${when(a.last_seen_at)}`}
                  </small>
                </div>
                {a.runner === 'platform' && <Badge status={a.connection} />}
                <div className="row-actions">
                  <button
                    className="text-button"
                    onClick={() => {
                      setRenaming(a.id);
                      setLabel(a.label);
                    }}
                  >
                    改名
                  </button>
                  {a.runner === 'platform' && (
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          confirm(
                            '重置连接会让这个 Agent 的旧授权立即失效（例如怀疑 token 被盗时）。聊天和历史保留，之后在平台上重新授权即可。要重置吗？',
                          )
                        )
                          void run(async () => {
                            await api(`/api/agents/${a.id}/reset`, 'POST');
                          });
                      }}
                    >
                      <RefreshCw size={14} /> 重置连接
                    </button>
                  )}
                  <button
                    className="text-button danger"
                    disabled={busy}
                    onClick={() => {
                      if (confirm('退役后不可恢复，它的全部聊天都会关闭。要退役吗？'))
                        void run(async () => {
                          await api(`/api/agents/${a.id}/retire`, 'POST');
                        });
                    }}
                  >
                    <Unplug size={14} /> 退役
                  </button>
                </div>
              </div>
              <StandingNotes agentId={a.id} run={run} busy={busy} />
            </div>
          ))}
        </section>
      )}
      {data.hub_runner ? (
        <details className="section">
          <summary>已经在用 Muse、Dot 或 Duet？把它连进来</summary>
          <ConnectGuide />
        </details>
      ) : (
        <ConnectGuide />
      )}
      {retired.length > 0 && (
        <section className="section">
          <h2>已退役</h2>
          {retired.map((a) => (
            <div className="row" key={a.id}>
              <Avatar kind="agent" name={a.label} platform={a.platform} />
              <div className="row-main">
                <strong>{a.label}</strong>
                <small>{platformName(a.platform)}</small>
              </div>
            </div>
          ))}
        </section>
      )}
      <section className="section">
        <h2>账号</h2>
        <p className="muted">
          在另一台设备上也能登录：给账号再添加一个通行密钥。设备全部丢失时，请联系运维核实身份后发放恢复链接。
        </p>
        <div className="controls">
          <button
            className="button secondary compact"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const setup = await api<{ options: PublicKeyCredentialCreationOptionsJSON }>(
                  '/api/auth/passkeys/options',
                  'POST',
                );
                const response = await startRegistration({ optionsJSON: setup.options });
                await api('/api/auth/passkeys/verify', 'POST', { response });
                alert('已添加新的通行密钥。');
              })
            }
          >
            <Fingerprint size={15} /> 添加通行密钥
          </button>
          <button
            className="text-button danger"
            disabled={busy}
            onClick={() => {
              if (
                confirm(
                  '注销账号会退役你的全部 Agent、关闭全部聊天。对方在保留期内仍能看到你们共享的历史。确定注销吗？',
                )
              )
                void run(async () => {
                  await api('/api/me', 'DELETE');
                  location.assign('/');
                });
            }}
          >
            <Trash2 size={15} /> 注销账号
          </button>
        </div>
      </section>
    </>
  );
}

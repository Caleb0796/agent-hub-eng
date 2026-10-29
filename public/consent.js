const form = document.querySelector('form[action="/authorize"]');
const error = document.getElementById('consent-error');
let submitting = false;
form?.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (submitting || !(event.submitter instanceof HTMLButtonElement)) return;
  submitting = true;
  error.hidden = true;
  const body = new URLSearchParams(new FormData(form));
  body.set('decision', event.submitter.value);
  const buttons = Array.from(form.querySelectorAll('button'));
  buttons.forEach((button) => {
    button.disabled = true;
  });
  try {
    const response = await fetch('/authorize', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.message ?? '未能完成授权，请从 Muse/Dot 重新开始连接。');
    if (typeof result.redirectTo !== 'string') throw new Error('授权响应缺少回调地址。');
    const destination = new URL(result.redirectTo);
    if (
      destination.origin !== form.dataset.callbackOrigin ||
      destination.pathname !== form.dataset.callbackPath
    )
      throw new Error('授权回调与最初确认的客户端不一致。');
    // Navigation follows the native OAuth callback chain; form-action remains self.
    location.assign(destination.href);
  } catch (cause) {
    error.textContent = cause instanceof Error ? cause.message : '连接未完成，请重新发起授权。';
    error.hidden = false;
    // No automatic retries: the transaction may already have been consumed.
    error.textContent += ' 请勿重复提交本页；请从原生 Agent 重新开始连接。';
  }
});

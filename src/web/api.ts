export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function csrf(): string {
  return (
    document.cookie
      .split(';')
      .map((x) => x.trim())
      .find((x) => x.startsWith('agent-hub-csrf='))
      ?.slice('agent-hub-csrf='.length) ?? ''
  );
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'X-CSRF-Token': csrf() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ApiError('invalid_response', response.status, '服务暂时无法返回结果，请稍后重试');
  }
  if (!response.ok) {
    const error = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    throw new ApiError(
      typeof error.error === 'string' ? error.error : 'request_failed',
      response.status,
      typeof error.message === 'string' ? error.message : '操作没有完成',
    );
  }
  return value as T;
}
export function navigate(path: string): void {
  history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, location.origin);
    return url.origin === location.origin ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

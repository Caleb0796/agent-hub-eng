import {
  createClient,
  type Client,
  type InValue,
  type ResultSet,
  type Transaction,
} from '@libsql/client';

export type SqlResult<T = Record<string, unknown>> = {
  results: T[];
  success: true;
  meta: { changes: number; last_row_id: number | null };
};
type Executor = Client | Transaction;

function result<T>(value: ResultSet): SqlResult<T> {
  return {
    results: value.rows.map((row) =>
      Object.fromEntries(value.columns.map((key) => [key, row[key]])),
    ) as T[],
    success: true,
    meta: {
      changes: value.rowsAffected,
      last_row_id: value.lastInsertRowid === undefined ? null : Number(value.lastInsertRowid),
    },
  };
}

export class Statement {
  constructor(
    readonly connection: Connection,
    readonly sql: string,
    readonly args: InValue[] = [],
  ) {}
  bind(...args: InValue[]): Statement {
    return new Statement(this.connection, this.sql, args);
  }
  async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    return result<T>(await this.connection.executor.execute({ sql: this.sql, args: this.args }));
  }
  async run(): Promise<SqlResult> {
    return this.all();
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = (await this.all<Record<string, unknown>>()).results[0];
    return row === undefined ? null : ((column ? row[column] : row) as T);
  }
}

/** SQLite's triggers and all statements in a batch commit together on the primary. */
export class Connection {
  constructor(readonly executor: Executor) {}
  prepare(sql: string): Statement {
    return new Statement(this, sql);
  }
  async batch<T = Record<string, unknown>>(statements: Statement[]): Promise<SqlResult<T>[]> {
    if (statements.some((s) => s.connection !== this))
      throw new Error('Mixed database connections');
    const inputs = statements.map((s) => ({ sql: s.sql, args: s.args }));
    const values =
      'commit' in this.executor
        ? await this.executor.batch(inputs)
        : await this.executor.batch(inputs, 'write');
    return values.map((value) => result<T>(value));
  }
}

/** Durable OAuth records. TTL is checked on every read, independently of cron cleanup. */
export class OAuthStore {
  constructor(
    private readonly connection: Connection,
    private readonly now = () => Math.floor(Date.now() / 1000),
  ) {}
  async get<T = string>(key: string, options?: string | { type?: string }): Promise<T | null> {
    const row = await this.connection
      .prepare(
        'SELECT value FROM oauth_records WHERE key=? AND (expires_at IS NULL OR expires_at>?)',
      )
      .bind(key, this.now())
      .first<{ value: string }>();
    if (!row) return null;
    const kind = typeof options === 'string' ? options : options?.type;
    if (kind && kind !== 'text' && kind !== 'json')
      throw new Error('Unsupported OAuth storage read type');
    return (kind === 'json' ? JSON.parse(row.value) : row.value) as T;
  }
  async put(
    key: string,
    value: string,
    options: { expirationTtl?: number; expiration?: number } = {},
  ): Promise<void> {
    if (typeof value !== 'string') throw new Error('OAuth storage accepts text records only');
    const expiry =
      options.expirationTtl === undefined
        ? (options.expiration ?? null)
        : this.now() + options.expirationTtl;
    await this.connection
      .prepare(
        'INSERT INTO oauth_records(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at',
      )
      .bind(key, value, expiry)
      .run();
  }
  async delete(key: string): Promise<void> {
    await this.connection.prepare('DELETE FROM oauth_records WHERE key=?').bind(key).run();
  }
  async list(options: { prefix?: string; cursor?: string; limit?: number } = {}) {
    const prefix = options.prefix ?? '',
      limit = Math.min(1000, Math.max(1, options.limit ?? 1000));
    const after = options.cursor ? Buffer.from(options.cursor, 'base64url').toString('utf8') : '';
    const { results } = await this.connection
      .prepare(
        'SELECT key,expires_at FROM oauth_records WHERE key>? AND substr(key,1,length(?))=? AND (expires_at IS NULL OR expires_at>?) ORDER BY key LIMIT ?',
      )
      .bind(after, prefix, prefix, this.now(), limit + 1)
      .all<{ key: string; expires_at: number | null }>();
    const more = results.length > limit,
      page = results.slice(0, limit);
    return {
      keys: page.map((row) => ({
        name: row.key,
        ...(row.expires_at === null ? {} : { expiration: row.expires_at }),
      })),
      list_complete: !more,
      cursor: more ? Buffer.from(page.at(-1)!.key).toString('base64url') : '',
      cacheStatus: null,
    };
  }
}

export function databaseClient(url: string, authToken?: string): Client {
  return createClient({ url, authToken, intMode: 'number' });
}

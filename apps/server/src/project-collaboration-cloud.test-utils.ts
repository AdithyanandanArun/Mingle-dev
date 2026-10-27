import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { SupabaseClient } from '@supabase/supabase-js';

type Row = Record<string, unknown>;
type Filter = { column: string; operator: string; value: unknown };
const identifier = (value: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Invalid fixture SQL identifier');
  return `"${value}"`;
};

/** A disposable PostgREST-shaped query boundary executing the actual PostgreSQL RLS and RPCs. */
export class ProjectInvitationCloudFixture {
  readonly pg = new PGlite();
  readonly errors: Array<{ table: string; code: unknown; message: unknown }> = [];
  private queue: Promise<unknown> = Promise.resolve();
  private readonly clients = new Map<string, SupabaseClient>();
  private readonly channels = new Set<{
    name: string; event: string | null; listener: (() => void) | null;
    status: ((state: string) => void) | null; subscribed: boolean;
  }>();
  readonly wakeTimings: Array<{ sentAt: number; deliveredAt: number | null }> = [];

  constructor(private readonly options: { realtime?: boolean; wakeDelayMs?: number } = {}) {}

  async initialize(users: Array<{ id: string; email: string }>) {
    await this.pg.exec(`
      CREATE ROLE anon NOLOGIN;
      CREATE ROLE authenticated NOLOGIN;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb DEFAULT '{}'::jsonb);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
      CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
      GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    `);
    await this.pg.exec(readFileSync(new URL('../../../supabase/migrations/20261022100932_mingle_teams.sql', import.meta.url), 'utf8'));
    await this.pg.exec(readFileSync(new URL('../../../supabase/migrations/20261024094104_mingle_project_collaboration.sql', import.meta.url), 'utf8'));
    await this.pg.exec(readFileSync(new URL('../../../supabase/migrations/20261024094433_mingle_invitation_limit_rls.sql', import.meta.url), 'utf8'));
    for (const user of users) await this.pg.query('INSERT INTO auth.users VALUES ($1,$2,now(),$3)', [user.id, user.email, JSON.stringify({ full_name: 'Example tester' })]);
  }

  async asUser<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      await this.pg.query("SELECT set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claims',$2,false)", [userId, JSON.stringify({ sub: userId, role: 'authenticated' })]);
      await this.pg.exec('SET ROLE authenticated');
      try { return await work(); } finally { await this.pg.exec('RESET ROLE'); }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }

  client(userId: string): SupabaseClient {
    const cached = this.clients.get(userId);
    if (cached) return cached;
    const client = {
      from: (table: string) => new FixtureQuery(this, userId, table),
      ...(this.options.realtime ? {
        // Only payload-free hints are simulated. All message bytes and authorization
        // still travel through the real encrypted mailbox and PostgreSQL policies.
        channel: (name: string) => {
          const state = { name, event: null as string | null, listener: null as (() => void) | null,
            status: null as ((state: string) => void) | null, subscribed: false };
          this.channels.add(state);
          const channel = {
            on: (_kind: string, filter: { event: string }, listener: () => void) => {
              state.event = filter.event; state.listener = listener; return channel;
            },
            subscribe: (callback: (status: string) => void) => {
              state.status = callback; state.subscribed = true;
              queueMicrotask(() => { if (state.subscribed) callback('SUBSCRIBED'); });
              return channel;
            },
            httpSend: async (event: string, payload: unknown) => {
              if (JSON.stringify(payload) !== '{}') throw new Error('Fixture wakes must contain no message data');
              const timing = { sentAt: performance.now(), deliveredAt: null as number | null };
              this.wakeTimings.push(timing);
              setTimeout(() => {
                timing.deliveredAt = performance.now();
                for (const receiver of this.channels) {
                  if (receiver.name === name && receiver.subscribed && receiver.event === event) receiver.listener?.();
                }
              }, this.options.wakeDelayMs ?? 0);
              return { success: true };
            },
            unsubscribe: async () => {
              state.subscribed = false; this.channels.delete(state); state.status?.('CLOSED'); return 'ok';
            },
          };
          return channel;
        },
        removeChannel: async (channel: { unsubscribe(): Promise<string> }) => channel.unsubscribe(),
      } : {}),
      rpc: async (name: string, args: Row = {}) => {
        try {
          return await this.asUser(userId, async () => {
            const parameters = Object.entries(args);
            const sql = `SELECT public.${identifier(name)}(${parameters.map(([key], index) => `${identifier(key)} => $${index + 1}`).join(',')}) AS result`;
            const result = await this.pg.query<{ result: unknown }>(sql, parameters.map(([, value]) => value));
            return { data: JSON.parse(JSON.stringify(result.rows[0]?.result ?? null)), error: null };
          });
        } catch (error) { return { data: null, error: { code: Reflect.get(error as object, 'code'), message: 'Example cloud RPC rejected' } }; }
      },
    } as unknown as SupabaseClient;
    this.clients.set(userId, client);
    return client;
  }

  async close() { await this.queue; await this.pg.close(); }
}

class FixtureQuery implements PromiseLike<{ data: unknown; error: unknown }> {
  private action = 'select';
  private fields = '*';
  private values: Row | Row[] | undefined;
  private returning = false;
  private one = false;
  private required = false;
  private filters: Filter[] = [];
  private ordering: string[] = [];
  private bound: number | undefined;
  private offset = 0;
  private conflict: string | undefined;
  private ignoreDuplicates = false;
  constructor(private cloud: ProjectInvitationCloudFixture, private userId: string, private table: string) {}
  select(fields = '*') { this.fields = fields; this.returning = true; return this; }
  insert(value: Row | Row[]) { this.action = 'insert'; this.values = value; return this; }
  upsert(value: Row | Row[], options: { onConflict?: string; ignoreDuplicates?: boolean } = {}) { this.action = 'insert'; this.values = value; this.conflict = options.onConflict; this.ignoreDuplicates = options.ignoreDuplicates ?? false; return this; }
  update(value: Row) { this.action = 'update'; this.values = value; return this; }
  delete() { this.action = 'delete'; return this; }
  eq(column: string, value: unknown) { this.filters.push({ column, operator: '=', value }); return this; }
  is(column: string, value: unknown) { this.filters.push({ column, operator: 'is', value }); return this; }
  in(column: string, value: unknown[]) { this.filters.push({ column, operator: 'in', value }); return this; }
  gte(column: string, value: unknown) { this.filters.push({ column, operator: '>=', value }); return this; }
  gt(column: string, value: unknown) { this.filters.push({ column, operator: '>', value }); return this; }
  order(column: string, options: { ascending?: boolean } = {}) { this.ordering.push(`${identifier(column)} ${options.ascending === false ? 'DESC' : 'ASC'}`); return this; }
  limit(bound: number) { this.bound = bound; return this; }
  range(from: number, to: number) { this.offset = from; this.bound = to - from + 1; return this; }
  single() { this.one = true; this.required = true; return this; }
  maybeSingle() { this.one = true; return this; }

  private async execute() {
    try {
      return await this.cloud.asUser(this.userId, async () => {
        const values: unknown[] = [];
        const parameter = (value: unknown) => { values.push(value); return `$${values.length}`; };
        const fields = this.fields === '*' ? '*' : this.fields.split(',').map(identifier).join(',');
        let sql: string;
        if (this.action === 'insert') {
          const rows = Array.isArray(this.values) ? this.values : [this.values!];
          const columns = Object.keys(rows[0]);
          sql = `INSERT INTO public.${identifier(this.table)} (${columns.map(identifier).join(',')}) VALUES ${rows.map(row => `(${columns.map(column => parameter(row[column])).join(',')})`).join(',')}`;
          if (this.conflict) sql += ` ON CONFLICT (${this.conflict.split(',').map(identifier).join(',')}) ${this.ignoreDuplicates ? 'DO NOTHING' : `DO UPDATE SET ${columns.filter(column => !this.conflict!.split(',').includes(column)).map(column => `${identifier(column)}=EXCLUDED.${identifier(column)}`).join(',')}`}`;
        } else if (this.action === 'update') {
          sql = `UPDATE public.${identifier(this.table)} SET ${Object.entries(this.values!).map(([key, value]) => `${identifier(key)}=${parameter(value)}`).join(',')}`;
        } else if (this.action === 'delete') sql = `DELETE FROM public.${identifier(this.table)}`;
        else sql = `SELECT ${fields} FROM public.${identifier(this.table)}`;
        if (this.filters.length) sql += ' WHERE ' + this.filters.map(filter => {
          const column = identifier(filter.column);
          if (filter.operator === 'is' && filter.value === null) return `${column} IS NULL`;
          if (filter.operator === 'in') {
            const entries = filter.value as unknown[];
            return entries.length ? `${column} IN (${entries.map(parameter).join(',')})` : 'FALSE';
          }
          return `${column} ${filter.operator} ${parameter(filter.value)}`;
        }).join(' AND ');
        if (this.action === 'select') {
          if (this.ordering.length) sql += ' ORDER BY ' + this.ordering.join(',');
          if (this.bound !== undefined) sql += ` LIMIT ${parameter(this.bound)}`;
          if (this.offset) sql += ` OFFSET ${parameter(this.offset)}`;
        } else if (this.returning) sql += ` RETURNING ${fields}`;
        const result = await this.cloud.pg.query(sql, values);
        const rows = JSON.parse(JSON.stringify(result.rows)) as unknown[];
        if (this.one && (rows.length > 1 || (this.required && !rows.length))) return { data: null, error: { code: 'PGRST116', message: 'Example single row mismatch' } };
        return { data: this.one ? rows[0] ?? null : this.action === 'select' || this.returning ? rows : null, error: null };
      });
    } catch (error) {
      this.cloud.errors.push({ table: this.table, code: Reflect.get(error as object, 'code'), message: Reflect.get(error as object, 'message') });
      return { data: null, error: { code: Reflect.get(error as object, 'code'), message: Reflect.get(error as object, 'message') } };
    }
  }

  then<T = { data: unknown; error: unknown }, U = never>(resolve?: ((value: { data: unknown; error: unknown }) => T | PromiseLike<T>) | null, reject?: ((reason: unknown) => U | PromiseLike<U>) | null): PromiseLike<T | U> {
    return this.execute().then(resolve, reject);
  }
}

// Browser-side stand-in for the Supabase client. It looks the same to the rest of TripPlanner
// (supabase.from('trips').select('*').eq('id', x).single() ...), but holds no database key:
// each query is sent to /projects/tripplanner/api/db, which checks who is asking and runs it
// on the server. Supports the subset the app uses: select / insert / update / delete,
// eq / neq / in, order, limit, single, maybeSingle.

type Row = Record<string, unknown>;
// Loose on purpose: the app reads rows with its own shapes, as it did with supabase-js.
// Works both as a list (select) and as one row (single).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Result = { data: any; error: { message: string } | null };

const ENDPOINT = '/projects/tripplanner/api/db';

export class Query implements PromiseLike<Result> {
  private q: {
    table: string;
    action: 'select' | 'insert' | 'update' | 'delete';
    columns?: string;
    values?: Row | Row[];
    filters: { op: 'eq' | 'neq' | 'in'; col: string; val: unknown }[];
    order: { col: string; ascending?: boolean }[];
    limit?: number;
    single?: 'single' | 'maybe';
    returning?: string | null;
  };

  constructor(table: string) {
    this.q = { table, action: 'select', filters: [], order: [], returning: null };
  }

  select(columns = '*') {
    if (this.q.action === 'select') this.q.columns = columns;
    else this.q.returning = columns;
    return this;
  }
  insert(values: Row | Row[]) { this.q.action = 'insert'; this.q.values = values; return this; }
  update(values: Row) { this.q.action = 'update'; this.q.values = values; return this; }
  delete() { this.q.action = 'delete'; return this; }
  eq(col: string, val: unknown) { this.q.filters.push({ op: 'eq', col, val }); return this; }
  neq(col: string, val: unknown) { this.q.filters.push({ op: 'neq', col, val }); return this; }
  in(col: string, val: unknown[]) { this.q.filters.push({ op: 'in', col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }) { this.q.order.push({ col, ascending: opts?.ascending }); return this; }
  limit(n: number) { this.q.limit = n; return this; }
  single() { this.q.single = 'single'; return this; }
  maybeSingle() { this.q.single = 'maybe'; return this; }

  private async send(): Promise<Result> {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(this.q),
        credentials: 'same-origin',
      });
      const body = await res.json().catch(() => null);
      if (!body) return { data: null, error: { message: `Request failed (${res.status})` } };
      return { data: body.data ?? null, error: body.error ?? null };
    } catch (e) {
      return { data: null, error: { message: e instanceof Error ? e.message : 'Network error' } };
    }
  }

  then<A = Result, B = never>(
    onfulfilled?: ((value: Result) => A | PromiseLike<A>) | null,
    onrejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.send().then(onfulfilled, onrejected);
  }
}

export const supabase: { from: (table: string) => Query } = {
  from: (table: string) => new Query(table),
};

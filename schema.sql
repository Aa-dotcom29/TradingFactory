-- PostgreSQL / Supabase-compatible production schema. Published decision rows are append-only.
create extension if not exists pgcrypto;
create type signal_state as enum ('PUBLISHED','ACTIVE','TARGET_1_HIT','TARGET_2_HIT','SL_HIT','TIME_EXIT','EXPIRED','REJECTED','CANCELLED');
create table if not exists signals (
 id uuid primary key default gen_random_uuid(), strategy text not null, symbol text not null,
 direction text not null check (direction in ('BULLISH','BEARISH')), state signal_state not null default 'PUBLISHED',
 published_at timestamptz not null default now(), market_at timestamptz not null, snapshot jsonb not null,
 setup_key text not null, unique(strategy, setup_key)
);
create index if not exists signals_published_idx on signals(published_at desc);
create index if not exists signals_filter_idx on signals(strategy,symbol,state);
create table if not exists signal_events (id uuid primary key default gen_random_uuid(), signal_id uuid not null references signals(id),
 at timestamptz not null default now(), previous_state signal_state, new_state signal_state not null, reason text not null, market_snapshot jsonb not null default '{}');
create index if not exists signal_events_signal_idx on signal_events(signal_id,at);
create table if not exists trades (id uuid primary key default gen_random_uuid(), signal_id uuid not null references signals(id),
 opened_at timestamptz not null default now(), closed_at timestamptz, entry numeric not null, exit numeric,
 quantity int not null, pnl numeric not null default 0, mfe numeric not null default 0, mae numeric not null default 0, exit_reason text);
create table if not exists market_snapshots(id uuid primary key default gen_random_uuid(), captured_at timestamptz not null, provider text not null, payload jsonb not null);
create table if not exists news_events(id uuid primary key default gen_random_uuid(), occurred_at timestamptz not null, source text, title text not null, summary text, url text, entity text, sentiment text, severity text, relevance numeric);
create table if not exists risk_decisions(id uuid primary key default gen_random_uuid(), signal_id uuid references signals(id), evaluated_at timestamptz not null default now(), passed boolean not null, reasons jsonb not null, quantity int not null);
create table if not exists system_health(id uuid primary key default gen_random_uuid(), component text not null, checked_at timestamptz not null default now(), status text not null, latency_ms int, detail text);
-- Server-side aggregate journal. A single row keeps this single-workspace MVP atomic;
-- normalized tables above are retained for the next multi-user/data-model stage.
create table if not exists tf_app_state (
 id text primary key check (id = 'main'),
 state jsonb not null,
 revision bigint not null default 0,
 updated_at timestamptz not null default now()
);
alter table tf_app_state add column if not exists revision bigint not null default 0;
-- Enforce immutability at the database boundary: lifecycle changes belong in signal_events.
create or replace function reject_signal_snapshot_update() returns trigger language plpgsql as $$
begin
 if new.snapshot is distinct from old.snapshot or new.published_at is distinct from old.published_at then
  raise exception 'Published signal snapshots are immutable';
 end if;
 return new;
end $$;
drop trigger if exists immutable_signal_snapshot on signals;
create trigger immutable_signal_snapshot before update on signals for each row execute function reject_signal_snapshot_update();

-- The aggregate may change lifecycle, prices and journal metrics, but never rewrite,
-- replace, or remove an already-published signal snapshot.
create or replace function protect_tf_app_state_snapshots() returns trigger language plpgsql as $$
declare prior_signal jsonb; current_signal jsonb;
begin
 for prior_signal in select entry.value from jsonb_array_elements(coalesce(old.state->'signals','[]'::jsonb)) as entry(value) loop
  current_signal := null;
  select entry.value into current_signal from jsonb_array_elements(coalesce(new.state->'signals','[]'::jsonb)) as entry(value)
   where entry.value->>'id' = prior_signal->>'id' limit 1;
  if current_signal is null then raise exception 'Published signals cannot be deleted from the state journal'; end if;
  if current_signal->'snapshot' is distinct from prior_signal->'snapshot' then
   raise exception 'Published signal snapshots are immutable';
  end if;
 end loop;
 return new;
end $$;
drop trigger if exists immutable_tf_app_state_snapshots on tf_app_state;
create trigger immutable_tf_app_state_snapshots before update on tf_app_state for each row execute function protect_tf_app_state_snapshots();

-- This app connects from its trusted server using DATABASE_URL. Do not expose its
-- shared-state tables to browser roles through Supabase's Data API.
alter table signals enable row level security;
alter table signal_events enable row level security;
alter table trades enable row level security;
alter table market_snapshots enable row level security;
alter table news_events enable row level security;
alter table risk_decisions enable row level security;
alter table system_health enable row level security;
alter table tf_app_state enable row level security;
revoke all on table signals,signal_events,trades,market_snapshots,news_events,risk_decisions,system_health,tf_app_state from public;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  revoke all on table signals,signal_events,trades,market_snapshots,news_events,risk_decisions,system_health,tf_app_state from anon;
 end if;
 if exists(select 1 from pg_roles where rolname='authenticated') then
  revoke all on table signals,signal_events,trades,market_snapshots,news_events,risk_decisions,system_health,tf_app_state from authenticated;
 end if;
end $$;

-- Trading Factory - market intelligence harness schema (Slice 0 backbone).
-- Portable across Postgres 13+ (Docker / Render / self-hosted VM). No extensions required:
-- gen_random_uuid() is built in on Postgres 13+, so this runs on a plain image.
--
-- Design notes:
--   * Time-series data (snapshots, OI spurts, news, features) is range-partitioned by month
--     with a DEFAULT partition so writes never fail, plus a helper to add future months.
--   * Published signals are immutable (trigger) and cannot be deleted inside the retention
--     floor (90 days by default) so history survives for backtesting and self-learning.
--   * The queue is plain SQL (FOR UPDATE SKIP LOCKED) so no extra broker/extension is needed.

begin;

create table if not exists schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Household / family accounts (auth wiring lands in Slice 1)
-- ---------------------------------------------------------------------------
create table if not exists households (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id            uuid primary key default gen_random_uuid(),
  household_id  uuid not null references households(id) on delete cascade,
  email         text not null unique,
  password_hash text not null,
  role          text not null default 'member' check (role in ('owner','member')),
  created_at    timestamptz not null default now()
);

-- Server-side sessions. Only a hash of the cookie token is stored, so a database
-- leak cannot be replayed as a live login. Logout/revocation is a row delete.
create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references profiles(id) on delete cascade,
  token_hash   text not null unique,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists sessions_profile_idx on sessions (profile_id);
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Operational tables
-- ---------------------------------------------------------------------------
create table if not exists sources_health (
  source        text primary key,
  status        text not null,
  detail        text,
  last_ok_at    timestamptz,
  last_error_at timestamptz,
  checked_at    timestamptz not null default now()
);

create table if not exists ingest_runs (
  id          uuid primary key default gen_random_uuid(),
  started_at  timestamptz not null,
  finished_at timestamptz,
  ok          boolean,
  worker      text,
  summary     jsonb not null default '{}'::jsonb
);

-- Dedupe registry kept OUTSIDE the partitioned news table so a hash is unique globally.
create table if not exists news_seen (
  dedupe_hash text primary key,
  first_seen  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Partitioned time-series tables
-- ---------------------------------------------------------------------------
create table if not exists market_snapshots (
  id          uuid not null default gen_random_uuid(),
  captured_at timestamptz not null,
  provider    text not null,
  symbol      text not null,
  kind        text not null default 'QUOTE' check (kind in ('QUOTE','GREEK','CHAIN')),
  payload     jsonb not null,
  primary key (id, captured_at)
) partition by range (captured_at);

create table if not exists oi_spurts (
  id               uuid not null default gen_random_uuid(),
  captured_at      timestamptz not null,
  source           text not null default 'NSE',
  scope            text not null check (scope in ('UNDERLYING','CONTRACT')),
  symbol           text,
  contract         text,
  oi               bigint,
  oi_change        bigint,
  volume           bigint,
  price            numeric,
  price_change_pct numeric,
  spurt_score      numeric,
  read             text,
  option_type      text,
  strike           numeric,
  expiry           text,
  bucket           text,
  payload          jsonb not null default '{}'::jsonb,
  primary key (id, captured_at)
) partition by range (captured_at);

create table if not exists news_items (
  id           uuid not null default gen_random_uuid(),
  published_at timestamptz not null,
  ingested_at  timestamptz not null default now(),
  source       text not null,
  url          text,
  title        text not null,
  summary      text,
  entities     jsonb not null default '[]'::jsonb,
  sentiment    numeric,
  severity     text,
  relevance    numeric,
  dedupe_hash  text not null,
  primary key (id, published_at)
) partition by range (published_at);

create table if not exists features (
  id          uuid not null default gen_random_uuid(),
  as_of       timestamptz not null,
  symbol      text not null,
  feature_set text not null,
  horizon     text,
  values      jsonb not null,
  primary key (id, as_of)
) partition by range (as_of);

-- ---------------------------------------------------------------------------
-- Signals (immutable, versioned, retention-protected)
-- ---------------------------------------------------------------------------
create table if not exists signals (
  id               uuid primary key default gen_random_uuid(),
  horizon          text not null check (horizon in ('INTRADAY','SWING','POSITIONAL')),
  strategy         text not null,
  symbol           text not null,
  direction        text not null check (direction in ('BULLISH','NEUTRAL','BEARISH')),
  instrument       text,
  strike           numeric,
  option_type      text check (option_type in ('CE','PE',NULL)),
  entry            numeric,
  target           numeric,
  stop             numeric,
  rr               numeric,
  probability      numeric,
  confidence       numeric,
  published_at     timestamptz not null default now(),
  strategy_version text not null,
  engine_version   text not null,
  model_version    text,
  config_version   text,
  setup_key        text not null,
  snapshot         jsonb not null,
  unique (strategy, setup_key)
);
create index if not exists signals_horizon_idx on signals (horizon, published_at desc);
create index if not exists signals_symbol_idx  on signals (symbol, published_at desc);

create table if not exists signal_events (
  id             uuid primary key default gen_random_uuid(),
  signal_id      uuid not null references signals(id) on delete cascade,
  at             timestamptz not null default now(),
  previous_state text,
  new_state      text not null,
  reason         text not null,
  market_snapshot jsonb not null default '{}'::jsonb
);
create index if not exists signal_events_signal_idx on signal_events (signal_id, at);

create table if not exists risk_decisions (
  id           uuid primary key default gen_random_uuid(),
  signal_id    uuid references signals(id) on delete set null,
  horizon      text,
  evaluated_at timestamptz not null default now(),
  passed       boolean not null,
  reasons      jsonb not null default '[]'::jsonb,
  payload      jsonb not null default '{}'::jsonb
);

create table if not exists outcomes (
  id           uuid primary key default gen_random_uuid(),
  signal_id    uuid not null references signals(id) on delete cascade,
  horizon      text,
  evaluated_at timestamptz not null default now(),
  result       text not null,
  entry        numeric,
  exit         numeric,
  pnl_pct      numeric,
  mfe          numeric,
  mae          numeric,
  bars_held    integer,
  payload      jsonb not null default '{}'::jsonb
);
create index if not exists outcomes_signal_idx on outcomes (signal_id);

-- governance: candidate configs produced by the learning loop, human-approved
create table if not exists config_registry (
  version     text primary key,
  created_at  timestamptz not null default now(),
  created_by  text,
  status      text not null default 'candidate' check (status in ('candidate','approved','retired')),
  metrics     jsonb not null default '{}'::jsonb,
  config      jsonb not null,
  approved_by uuid,
  approved_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Plain-SQL queue (replaces a broker; portable; FOR UPDATE SKIP LOCKED)
-- ---------------------------------------------------------------------------
create table if not exists queue_messages (
  id           bigserial primary key,
  topic        text not null,
  idem_key     text,
  horizon      text,
  payload      jsonb not null,
  state        text not null default 'pending' check (state in ('pending','processing','done','dead')),
  attempts     integer not null default 0,
  max_attempts integer not null default 5,
  visible_at   timestamptz not null default now(),
  reserved_by  text,
  reserved_at  timestamptz,
  last_error   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index if not exists queue_idem_idx
  on queue_messages (topic, idem_key) where idem_key is not null;
create index if not exists queue_poll_idx
  on queue_messages (topic, state, visible_at);

-- ---------------------------------------------------------------------------
-- Immutability + retention floor for published signals
-- ---------------------------------------------------------------------------
create or replace function tf_reject_signal_snapshot_update() returns trigger
language plpgsql as $$
begin
  if new.snapshot is distinct from old.snapshot
     or new.published_at is distinct from old.published_at then
    raise exception 'Published signal snapshots are immutable';
  end if;
  return new;
end $$;

drop trigger if exists signals_immutable_snapshot on signals;
create trigger signals_immutable_snapshot
  before update on signals
  for each row execute function tf_reject_signal_snapshot_update();

create or replace function tf_protect_recent_signals() returns trigger
language plpgsql as $$
begin
  if old.published_at > now() - interval '90 days' then
    raise exception 'Retention floor: signals younger than 90 days cannot be deleted';
  end if;
  return old;
end $$;

drop trigger if exists signals_retention_floor on signals;
create trigger signals_retention_floor
  before delete on signals
  for each row execute function tf_protect_recent_signals();

-- ---------------------------------------------------------------------------
-- Partition management
-- ---------------------------------------------------------------------------
create or replace function tf_ensure_partitions(months_ahead integer default 3) returns void
language plpgsql as $$
declare
  parent      text;
  i           integer;
  start_month date;
  part_name   text;
begin
  foreach parent in array array['market_snapshots','oi_spurts','news_items','features'] loop
    for i in 0..months_ahead loop
      start_month := (date_trunc('month', now()) + (i || ' month')::interval)::date;
      part_name := format('%s_%s', parent, to_char(start_month, 'YYYYMM'));
      execute format(
        'create table if not exists %I partition of %I for values from (%L) to (%L)',
        part_name, parent, start_month, start_month + interval '1 month'
      );
    end loop;
    execute format('create table if not exists %I partition of %I default', parent || '_default', parent);
  end loop;
end $$;

select tf_ensure_partitions(3);

insert into schema_migrations (version) values ('0001_harness_backbone')
  on conflict (version) do nothing;
insert into schema_migrations (version) values ('0002_slice1_auth')
  on conflict (version) do nothing;

commit;

-- Internal usage/health events. event_type is deliberately free text so future
-- event types (e.g. 'abandoned_cart_email_sent') need no schema change.
-- created_at is stored in UTC (timestamptz); display-time bucketing converts to
-- the reporting timezone in the metrics CLI, never here.
create table if not exists events (
  id         bigint generated always as identity primary key,
  client_id  text not null,
  event_type text not null,
  created_at timestamptz not null default now(),
  metadata   jsonb
);

create index if not exists events_client_created_idx on events (client_id, created_at);
create index if not exists events_type_created_idx on events (event_type, created_at);

-- Client tiers. Existing rows default to 'regular' — nobody is silently upgraded.
alter table clients add column if not exists tier text not null default 'regular';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'clients_tier_check') then
    alter table clients add constraint clients_tier_check check (tier in ('regular', 'premium'));
  end if;
end $$;

-- Abandoned checkouts detected for tier-gated cart recovery.
create table if not exists abandoned_checkouts (
  id                  bigint generated always as identity primary key,
  client_id           text not null,
  shopify_checkout_id text not null,
  customer_email      text,
  recovery_url        text,
  cart_snapshot       jsonb,
  detected_at         timestamptz not null default now(),
  emails_sent         integer not null default 0,
  last_email_sent_at  timestamptz,
  recovered_at        timestamptz,
  unsubscribed        boolean not null default false,
  unique (client_id, shopify_checkout_id)
);

create index if not exists abandoned_client_open_idx
  on abandoned_checkouts (client_id, recovered_at, unsubscribed, emails_sent);
create index if not exists abandoned_email_idx on abandoned_checkouts (client_id, customer_email);

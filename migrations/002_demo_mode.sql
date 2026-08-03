-- Demo mode: prospects run on a scraped snapshot of their public catalogue
-- until they grant real API access. Existing rows default to 'live' and are
-- untouched. Shopify credentials become nullable because demo rows have none.
alter table clients add column if not exists mode text not null default 'live';
alter table clients add column if not exists demo_catalog jsonb;

alter table clients alter column shopify_client_id drop not null;
alter table clients alter column shopify_client_secret drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'clients_mode_check'
  ) then
    alter table clients add constraint clients_mode_check check (mode in ('live', 'demo'));
  end if;
end $$;

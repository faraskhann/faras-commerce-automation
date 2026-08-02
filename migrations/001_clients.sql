-- Multi-tenant client registry. One row per Shopify store this deployment serves.
-- client_id is the public identifier embedded in the widget script tag;
-- the Shopify credentials are secrets and must never leave the backend.
create table if not exists clients (
  client_id             text primary key,
  store_domain          text not null,
  shopify_client_id     text not null,
  shopify_client_secret text not null,
  -- Comma-separated list of exact origins allowed to call /chat for this client,
  -- e.g. 'https://acme.myshopify.com,https://www.acme.com'
  allowed_origin        text not null,
  created_at            timestamptz not null default now()
);

create index if not exists clients_store_domain_idx on clients (store_domain);

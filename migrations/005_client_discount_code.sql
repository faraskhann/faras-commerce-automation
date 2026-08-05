-- Per-client stage-3 discount code, replacing the global env var.
-- Nullable: a client without a code simply gets no discount in the email.
alter table clients add column if not exists discount_code text;

-- Result of the last validation against that client's own Shopify store.
-- status is null until first checked; 'valid' means Shopify confirmed it is
-- active, in-window and not exhausted.
alter table clients add column if not exists discount_code_status text;
alter table clients add column if not exists discount_code_checked_at timestamptz;

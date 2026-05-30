-- =============================================================================
-- 0009_platform.sql
-- Cross-shop / platform tables. These do NOT use the standard tenant pattern:
--   - end users never write here; the service role (Edge Functions, import
--     scripts) does the writing, bypassing RLS.
--   - access is custom per table (owner-read vs admin-only vs service-only).
-- Adds webhook_events for payment idempotency (flagged in 0003 notes; NOT in
-- the original ERD — confirm whether to add it to the ERD too).
-- =============================================================================

-- ---------- Subscriptions: one per shop. Written by provisioning/webhooks. ----
create table public.subscriptions (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  provider            public.subscription_provider not null,
  status              public.subscription_status not null default 'active',
  plan                text,
  current_period_end  timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index subscriptions_shop_id_idx on public.subscriptions (shop_id);

create trigger set_subscriptions_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------- Bank-transfer proofs: exist BEFORE a tenant does. -----------------
-- Prospect uploads via an Edge Function (service role). Admin validates.
-- shop_id is filled on approval, when the tenant is created.
create table public.bank_transfer_proofs (
  id             uuid primary key default gen_random_uuid(),
  business_name  text not null,
  email          text not null,
  proof_url      text,
  amount         numeric(12,2),
  status         public.bank_transfer_status not null default 'pending',
  shop_id        uuid references public.shops(id) on delete set null,
  validated_by   uuid references auth.users(id) on delete set null,
  validated_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index bank_transfer_proofs_status_idx on public.bank_transfer_proofs (status);

-- ---------- Notification log: written by Edge Functions (service role). -------
create table public.notification_log (
  id                   uuid primary key default gen_random_uuid(),
  shop_id              uuid not null references public.shops(id) on delete cascade,
  customer_id          uuid references public.customers(id) on delete set null,
  channel              public.notification_channel not null,
  template             public.notification_template not null,
  related_entity_type  text,   -- 'appointment' | 'work_order' | 'quote' | ...
  related_entity_id    uuid,
  payload              jsonb,
  status               public.notification_status not null default 'queued',
  attempts             int not null default 0,
  error                text,
  sent_at              timestamptz,
  created_at           timestamptz not null default now()
);
create index notification_log_shop_id_idx on public.notification_log (shop_id);
create index notification_log_status_idx  on public.notification_log (status);

-- ---------- Migration validations: admin tooling only. ------------------------
create table public.migration_validations (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  record_counts  jsonb,
  flagged_issues jsonb,
  go_no_go       public.migration_decision not null default 'pending',
  validated_by   uuid references auth.users(id) on delete set null,
  validated_at   timestamptz,
  created_at     timestamptz not null default now()
);
create index migration_validations_shop_id_idx on public.migration_validations (shop_id);

-- ---------- Webhook events: idempotency ledger. Service role only. ------------
create table public.webhook_events (
  id          uuid primary key default gen_random_uuid(),
  provider    public.subscription_provider not null,
  event_type  text,
  external_id text,                 -- provider event/transaction id
  payload     jsonb not null,
  shop_id     uuid references public.shops(id) on delete set null,
  processed   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (provider, external_id)    -- dedupe: a webhook can fire twice
);

-- =====================================================================
-- RLS — custom per table
-- =====================================================================

alter table public.subscriptions         enable row level security;
alter table public.bank_transfer_proofs  enable row level security;
alter table public.notification_log       enable row level security;
alter table public.migration_validations  enable row level security;
alter table public.webhook_events         enable row level security;

-- subscriptions: owner reads own; admin full control. Writes otherwise via service role.
create policy subscriptions_select on public.subscriptions
  for select to authenticated
  using ( shop_id = (select private.current_shop_id())
          or (select private.is_platform_admin()) );
create policy subscriptions_admin_all on public.subscriptions
  for all to authenticated
  using ( (select private.is_platform_admin()) )
  with check ( (select private.is_platform_admin()) );

-- bank_transfer_proofs: admin only (prospects write via service role).
create policy btp_admin_all on public.bank_transfer_proofs
  for all to authenticated
  using ( (select private.is_platform_admin()) )
  with check ( (select private.is_platform_admin()) );

-- notification_log: read-only for owners (own shop) and admins; writes via service role.
create policy notification_log_select on public.notification_log
  for select to authenticated
  using ( shop_id = (select private.current_shop_id())
          or (select private.is_platform_admin()) );

-- migration_validations: admin only.
create policy migration_validations_admin_all on public.migration_validations
  for all to authenticated
  using ( (select private.is_platform_admin()) )
  with check ( (select private.is_platform_admin()) );

-- webhook_events: no policies => only the service role (bypasses RLS) touches it.

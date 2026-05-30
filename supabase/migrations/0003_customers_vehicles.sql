-- =============================================================================
-- 0003_customers_vehicles.sql
-- Customers, their vehicles, and LOPDP documents.
-- First domain on the standard tenant pattern (via private.apply_tenant_rls).
-- =============================================================================

-- =====================================================================
-- TABLES
-- =====================================================================

-- Fleet/Empresa collapsed into a flag (fixes the Zoho entity collision).
create table public.customers (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  name             text not null,
  is_fleet         boolean not null default false,
  fleet_name       text,
  whatsapp_number  text,   -- preferred customer contact channel
  email            text,
  phone            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index customers_shop_id_idx on public.customers (shop_id);

-- fuel_type corrects the mislabeled 'tipo_vehiculo' from Zoho.
create table public.vehicles (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  make          text,
  model         text,
  year          int,
  plate         text,
  fuel_type     text,
  mileage       int,
  alarm_code    text,
  vin_photo_url text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index vehicles_shop_id_idx     on public.vehicles (shop_id);
create index vehicles_customer_id_idx on public.vehicles (customer_id);

-- LOPDP: ID upload + native touch signature + consent metadata.
create table public.customer_documents (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  customer_id      uuid not null references public.customers(id) on delete cascade,
  id_document_url  text,
  signature_url    text,
  consent_given    boolean not null default false,
  consent_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index customer_documents_customer_id_idx on public.customer_documents (customer_id);

-- =====================================================================
-- updated_at TRIGGERS  (customer_documents is append-only: no updated_at)
-- =====================================================================
create trigger set_customers_updated_at
  before update on public.customers
  for each row execute function public.set_updated_at();

create trigger set_vehicles_updated_at
  before update on public.vehicles
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS — standard tenant pattern
-- =====================================================================
select private.apply_tenant_rls('customers');
select private.apply_tenant_rls('vehicles');
select private.apply_tenant_rls('customer_documents');

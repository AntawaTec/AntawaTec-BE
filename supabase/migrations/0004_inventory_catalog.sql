-- =============================================================================
-- 0004_inventory_catalog.sql
-- Inventory catalog: suppliers, products, services.
-- Comes before quotation because quote_items references products/services.
-- Stock is NOT stored here — it is calculated from inventory_movements (0008).
-- =============================================================================

create table public.suppliers (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  contact     text,
  phone       text,
  email       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index suppliers_shop_id_idx on public.suppliers (shop_id);

create table public.products (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  supplier_id      uuid references public.suppliers(id) on delete set null,
  brand            text,
  model            text,
  name             text not null,
  uom              text,            -- unit of measure
  cost             numeric(12,2),
  suggested_price  numeric(12,2),
  threshold        numeric(12,2) not null default 0,  -- low-stock alert level
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz
);
create index products_shop_id_idx     on public.products (shop_id);
create index products_supplier_id_idx on public.products (supplier_id);

create table public.services (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  name        text not null,
  price       numeric(12,2),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index services_shop_id_idx on public.services (shop_id);

-- updated_at triggers
create trigger set_suppliers_updated_at before update on public.suppliers
  for each row execute function public.set_updated_at();
create trigger set_products_updated_at  before update on public.products
  for each row execute function public.set_updated_at();
create trigger set_services_updated_at  before update on public.services
  for each row execute function public.set_updated_at();

-- RLS — standard tenant pattern
select private.apply_tenant_rls('suppliers');
select private.apply_tenant_rls('products');
select private.apply_tenant_rls('services');

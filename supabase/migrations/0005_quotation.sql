-- =============================================================================
-- 0005_quotation.sql
-- Quotation: quotes -> quote_sections -> quote_items.
-- Totals are written by the app on save (denormalized).
-- An approved quote auto-converts to an appointment via the app/edge layer
-- (not a DB trigger — see CLAUDE.md §8); the FK link lives on appointments (0006).
-- =============================================================================

create table public.quotes (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete restrict,
  vehicle_id  uuid not null references public.vehicles(id)  on delete restrict,
  status      public.quote_status not null default 'draft',
  subtotal    numeric(12,2) not null default 0,
  tax         numeric(12,2) not null default 0,
  total       numeric(12,2) not null default 0,
  approved_at timestamptz,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index quotes_shop_id_idx     on public.quotes (shop_id);
create index quotes_customer_id_idx on public.quotes (customer_id);
create index quotes_vehicle_id_idx  on public.quotes (vehicle_id);

create table public.quote_sections (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  quote_id      uuid not null references public.quotes(id) on delete cascade,
  section_type  public.quote_section_type not null,
  subtotal      numeric(12,2) not null default 0
);
create index quote_sections_quote_id_idx on public.quote_sections (quote_id);

create table public.quote_items (
  id               uuid primary key default gen_random_uuid(),
  shop_id          uuid not null references public.shops(id) on delete cascade,
  quote_section_id uuid not null references public.quote_sections(id) on delete cascade,
  item_type        public.quote_item_type not null,
  product_id       uuid references public.products(id) on delete set null,
  service_id       uuid references public.services(id) on delete set null,
  description      text,
  quantity         numeric(12,2) not null default 1,
  unit_price       numeric(12,2) not null default 0,
  line_total       numeric(12,2) not null default 0,
  -- An item points to at most one catalog entry (or is free-text).
  constraint quote_items_ref_ck
    check (not (product_id is not null and service_id is not null))
);
create index quote_items_section_id_idx on public.quote_items (quote_section_id);

-- updated_at trigger (only quotes carries updated_at; sections/items cascade with it)
create trigger set_quotes_updated_at before update on public.quotes
  for each row execute function public.set_updated_at();

-- RLS — standard tenant pattern
select private.apply_tenant_rls('quotes');
select private.apply_tenant_rls('quote_sections');
select private.apply_tenant_rls('quote_items');

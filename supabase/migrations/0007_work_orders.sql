-- =============================================================================
-- 0007_work_orders.sql
-- The single Work Order entity + its children.
-- Status Kanban, technician workload, "in process" and delivery are all
-- FILTERED VIEWS of work_orders.status — never separate tables.
-- Status transitions and notification dispatch happen in the app/edge layer.
-- =============================================================================

create table public.work_orders (
  id                      uuid primary key default gen_random_uuid(),
  shop_id                 uuid not null references public.shops(id) on delete cascade,
  customer_id             uuid not null references public.customers(id) on delete restrict,
  vehicle_id              uuid not null references public.vehicles(id)  on delete restrict,
  appointment_id          uuid references public.appointments(id) on delete set null,
  technician_id           uuid references public.technicians(id)  on delete set null,
  mileage_in              int,
  fuel_level              text,
  checklist               jsonb not null default '{}'::jsonb,   -- jack, tools, kit, ...
  liability_signature_url text,
  estimated_total         numeric(12,2),
  status                  public.work_order_status not null default 'reception',
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index work_orders_shop_id_idx     on public.work_orders (shop_id);
create index work_orders_status_idx       on public.work_orders (shop_id, status);  -- Kanban / filtered views
create index work_orders_technician_idx   on public.work_orders (technician_id);     -- technician workload
create index work_orders_customer_id_idx  on public.work_orders (customer_id);
create index work_orders_vehicle_id_idx   on public.work_orders (vehicle_id);

-- 4-angle photos + optional short video clips.
create table public.work_order_media (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  work_order_id uuid not null references public.work_orders(id) on delete cascade,
  media_type    public.work_order_media_type not null,
  url           text not null,
  angle         text,   -- front | back | left | right (photos)
  created_at    timestamptz not null default now()
);
create index work_order_media_wo_idx on public.work_order_media (work_order_id);

-- Progress Logs module: per-vehicle timeline.
create table public.work_order_logs (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  work_order_id       uuid not null references public.work_orders(id) on delete cascade,
  mileage             int,
  notes               text,
  future_maintenance  text,
  attachments         jsonb not null default '[]'::jsonb,
  created_by          uuid references auth.users(id) on delete set null,
  created_at          timestamptz not null default now()
);
create index work_order_logs_wo_idx on public.work_order_logs (work_order_id);

-- Vehicle Delivery: 1:1 closing record (unique work_order_id).
create table public.work_order_deliveries (
  id                  uuid primary key default gen_random_uuid(),
  shop_id             uuid not null references public.shops(id) on delete cascade,
  work_order_id       uuid not null unique references public.work_orders(id) on delete cascade,
  final_mileage       int,
  services_summary    text,
  future_maintenance  text,
  delivery_pdf_url    text,
  attachments         jsonb not null default '[]'::jsonb,
  delivered_at        timestamptz,
  created_at          timestamptz not null default now()
);

-- updated_at trigger (children are append-only)
create trigger set_work_orders_updated_at before update on public.work_orders
  for each row execute function public.set_updated_at();

-- RLS — standard tenant pattern
select private.apply_tenant_rls('work_orders');
select private.apply_tenant_rls('work_order_media');
select private.apply_tenant_rls('work_order_logs');
select private.apply_tenant_rls('work_order_deliveries');

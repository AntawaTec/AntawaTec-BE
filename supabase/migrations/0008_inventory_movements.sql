-- =============================================================================
-- 0008_inventory_movements.sql
-- Inventory movements + the calculated-stock view.
-- Comes after work_orders because a consumption movement links to a work order.
-- CONVENTION: quantity is SIGNED. purchase => +, consumption => -, adjustment => ±.
-- Current stock = SUM(quantity). There is no writable stock column anywhere.
-- The consumption write on a WO moving to 'in_process' is done by the app/edge
-- layer (see CLAUDE.md §8), not a DB trigger.
-- =============================================================================

create table public.inventory_movements (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  product_id     uuid not null references public.products(id) on delete cascade,
  movement_type  public.inventory_movement_type not null,
  quantity       numeric(12,2) not null,   -- signed; see convention above
  unit_cost      numeric(12,2),
  work_order_id  uuid references public.work_orders(id) on delete set null,  -- set on consumption
  notes          text,
  created_by     uuid references auth.users(id) on delete set null,
  created_at     timestamptz not null default now()
);
create index inventory_movements_shop_id_idx    on public.inventory_movements (shop_id);
create index inventory_movements_product_id_idx on public.inventory_movements (product_id);
create index inventory_movements_wo_idx         on public.inventory_movements (work_order_id);

-- RLS — standard tenant pattern
select private.apply_tenant_rls('inventory_movements');

-- ---------------------------------------------------------------------
-- Calculated stock view.
-- security_invoker = true => the view runs with the QUERYING user's
-- privileges, so RLS on products and inventory_movements still applies
-- (a shop only ever sees its own stock).
-- ---------------------------------------------------------------------
create view public.v_product_stock
  with (security_invoker = true)
as
  select
    p.id                                   as product_id,
    p.shop_id                              as shop_id,
    p.name                                 as product_name,
    p.threshold                            as threshold,
    coalesce(sum(m.quantity), 0)           as current_stock,
    (coalesce(sum(m.quantity), 0) <= p.threshold) as below_threshold
  from public.products p
  left join public.inventory_movements m on m.product_id = p.id
  where p.deleted_at is null
  group by p.id, p.shop_id, p.name, p.threshold;

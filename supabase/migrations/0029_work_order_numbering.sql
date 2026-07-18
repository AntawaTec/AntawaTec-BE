-- =============================================================================
-- 0029_work_order_numbering.sql
-- Número de orden correlativo POR taller (work_orders.order_number).
-- Feedback del piloto: "cada orden debe tener un número para poder distinguirlas".
-- Réplica exacta del diseño de 0012 (quote_number) — mismo razonamiento, mismos
-- trade-offs; ver el header de 0012 para el detalle completo de concurrencia,
-- sentinela DEFAULT 0 y por qué "sin huecos" no es una garantía (una orden de
-- taller no es un comprobante fiscal SRI).
--
-- Resumen del patrón:
--   * Contador por taller en `private` (invisible a authenticated: sin USAGE del
--     esquema, no sale por PostgREST ni en los tipos generados).
--   * Columna NOT NULL DEFAULT 0 => TablesInsert<"work_orders"> la marca OPCIONAL
--     y createWorkOrder (FE) no la manda; el 0 es sentinela que el trigger
--     BEFORE INSERT siempre reemplaza.
--   * Trigger coalesce-aware: authenticated llega con 0 => asigna del contador;
--     un import service_role puede traer número explícito (>0) => se conserva y
--     el contador se adelanta con greatest().
--   * Orden: columna -> backfill -> seed contador -> unique -> trigger.
-- =============================================================================

-- ---------- Contador por taller (interno; solo lo toca el trigger) -----------
create table private.shop_work_order_counters (
  shop_id      uuid primary key references public.shops(id) on delete cascade,
  last_number  int not null default 0
);
alter table private.shop_work_order_counters enable row level security;

-- ---------- Columna (NOT NULL DEFAULT 0; ver nota del sentinela en 0012) -----
alter table public.work_orders add column order_number int not null default 0;

-- ---------- Backfill determinista de las órdenes existentes ------------------
-- Numera por taller ordenando por created_at; desempata por id (orden estable).
with numbered as (
  select id,
         row_number() over (partition by shop_id order by created_at, id) as n
  from public.work_orders
)
update public.work_orders w
   set order_number = numbered.n
  from numbered
 where numbered.id = w.id;

-- ---------- Sembrar el contador al máximo por taller -------------------------
-- Talleres sin órdenes no obtienen fila; el trigger la crea perezosamente.
insert into private.shop_work_order_counters (shop_id, last_number)
select shop_id, max(order_number)
  from public.work_orders
 group by shop_id;

-- Backstop con nombre explícito (estilo 0011/0012) para distinguir el 23505.
alter table public.work_orders
  add constraint work_orders_shop_number_unique unique (shop_id, order_number);

-- ---------- Trigger de asignación (SECURITY DEFINER, search_path='') ---------
create or replace function private.assign_work_order_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.order_number is null or new.order_number = 0 then
    -- Camino normal (authenticated): asignar el siguiente número del taller.
    insert into private.shop_work_order_counters as c (shop_id, last_number)
    values (new.shop_id, 1)
    on conflict (shop_id) do update
      set last_number = c.last_number + 1
    returning c.last_number into new.order_number;
  else
    -- Camino import (service_role): conservar el número suministrado y adelantar
    -- el contador para que los próximos auto-números no colisionen.
    insert into private.shop_work_order_counters as c (shop_id, last_number)
    values (new.shop_id, new.order_number)
    on conflict (shop_id) do update
      set last_number = greatest(c.last_number, excluded.last_number);
  end if;
  return new;
end;
$$;

revoke execute on function private.assign_work_order_number() from public;

create trigger assign_work_order_number
  before insert on public.work_orders
  for each row execute function private.assign_work_order_number();

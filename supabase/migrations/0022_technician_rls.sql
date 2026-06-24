-- =============================================================================
-- 0022_technician_rls.sql  (S1 — borde RLS)
-- Acceso del técnico, PURAMENTE ADITIVO: ninguna política owner/admin se toca.
-- Como current_shop_id() es NULL para técnicos (0021), las políticas genéricas ya
-- los niegan en TODAS las tablas; acá se otorga de vuelta SOLO lo necesario.
--
-- Matriz del técnico (V1, scope narrow):
--   work_orders          SELECT/UPDATE  → solo las asignadas (technician_id = mi id)
--   work_order_logs      SELECT/INSERT  → de mis órdenes (append-only)
--   work_order_media     SELECT/INSERT  → de mis órdenes (fotos)
--   customers/vehicles   SELECT         → solo los de mis órdenes (para los embeds)
--   technicians          SELECT         → solo mi propia fila (embed "asignado a")
--   storage vehicle-media ALL           → carpeta {mi shop}/ (subir/leer fotos)
--   inventory_movements / deliveries    → SIN política técnica (owner-only): el
--     consumo y la entrega son escrituras de alto blast-radius (costos, stock,
--     cierre); quedan para el owner en V1. Follow-up aditivo si se necesita.
-- Las escrituras NUNCA reasignan: el WITH CHECK fija technician_id = mi id.
-- =============================================================================

-- Helper: el shop real del técnico (current_shop_id() es NULL para él). SECURITY
-- DEFINER para que la política de storage lo lea sin chocar con la RLS de profiles.
create or replace function private.current_member_shop_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select shop_id from public.profiles where id = (select auth.uid());
$$;
revoke execute on function private.current_member_shop_id() from public;
grant  execute on function private.current_member_shop_id() to authenticated;

-- ---------- work_orders: ver / actualizar SOLO las asignadas ----------
create policy work_orders_tech_select on public.work_orders
  for select to authenticated
  using (technician_id = (select private.current_technician_id()));

create policy work_orders_tech_update on public.work_orders
  for update to authenticated
  using (technician_id = (select private.current_technician_id()))
  with check (technician_id = (select private.current_technician_id()));
-- (no INSERT/DELETE para técnicos: crear/borrar órdenes es del owner. El WITH
--  CHECK impide que el técnico se reasigne la orden a otro o la saque de sí mismo.)

-- ---------- work_order_logs: bitácora de mis órdenes (append-only) ----------
create policy work_order_logs_tech_select on public.work_order_logs
  for select to authenticated
  using ((select private.is_my_work_order(work_order_id)));

create policy work_order_logs_tech_insert on public.work_order_logs
  for insert to authenticated
  with check (
    (select private.is_my_work_order(work_order_id))
    and shop_id = (select w.shop_id from public.work_orders w where w.id = work_order_id)
  );

-- ---------- work_order_media: fotos de mis órdenes ----------
create policy work_order_media_tech_select on public.work_order_media
  for select to authenticated
  using ((select private.is_my_work_order(work_order_id)));

create policy work_order_media_tech_insert on public.work_order_media
  for insert to authenticated
  with check (
    (select private.is_my_work_order(work_order_id))
    and shop_id = (select w.shop_id from public.work_orders w where w.id = work_order_id)
  );

-- ---------- customers / vehicles: SOLO los referenciados por mis órdenes ----------
-- Least-privilege para que resuelvan los embeds de la orden (no shop-wide).
create policy customers_tech_select on public.customers
  for select to authenticated
  using (exists (
    select 1 from public.work_orders w
    where w.customer_id = customers.id
      and w.technician_id = (select private.current_technician_id())
  ));

create policy vehicles_tech_select on public.vehicles
  for select to authenticated
  using (exists (
    select 1 from public.work_orders w
    where w.vehicle_id = vehicles.id
      and w.technician_id = (select private.current_technician_id())
  ));

-- ---------- technicians: el técnico lee su propia fila (embed "asignado a") ----------
create policy technicians_tech_select on public.technicians
  for select to authenticated
  using (id = (select private.current_technician_id()));

-- ---------- Storage: el técnico sube/lee fotos bajo su carpeta {shop}/ ----------
-- current_shop_id() es NULL para técnicos → la política genérica los bloquea;
-- carve-out aditivo solo en vehicle-media (folder-scoped al shop del técnico).
-- Residual aceptado: dentro de su MISMO shop podría adivinar el path de la foto de
-- otra orden; cross-shop sigue cerrado y el ACL real es la fila work_order_media.
create policy "vehicle-media_tech_all" on storage.objects
  for all to authenticated
  using (
    bucket_id = 'vehicle-media'
    and (select private.current_technician_id()) is not null
    and (storage.foldername(name))[1] = (select private.current_member_shop_id())::text
  )
  with check (
    bucket_id = 'vehicle-media'
    and (select private.current_technician_id()) is not null
    and (storage.foldername(name))[1] = (select private.current_member_shop_id())::text
  );

-- =============================================================================
-- 0030_technician_catalog_write.sql
-- El técnico puede EDITAR los trabajos del catálogo de SUS órdenes asignadas.
-- Feedback del piloto: "el técnico debe poder añadir trabajos del catálogo".
--
-- Revierte la decisión "escritura owner-only en V1" de 0025 (que ya anticipaba:
-- "follow-up aditivo si producto lo pide" — producto lo pidió). Puramente ADITIVO
-- (patrón 0022): las políticas genéricas de apply_tenant_rls no se tocan; como
-- current_shop_id() es NULL para técnicos, ellas ya lo niegan y estas lo re-otorgan
-- SOLO sobre selecciones de órdenes donde technician_id = su id.
--
-- Van las TRES escrituras porque el FE (saveCatalogSelections) es un reconciliador
-- insert/update/delete: agrega nodos nuevos, actualiza valor/nota de existentes y
-- borra los destildados. El SELECT del técnico ya existe (0025).
-- =============================================================================

-- INSERT: solo en mis órdenes, y el shop_id denormalizado debe ser el de la orden
-- (mismo candado que work_order_logs_tech_insert en 0022 — el técnico no puede
-- inventar un shop_id ajeno aunque la orden sea suya).
create policy work_order_catalog_selections_tech_insert
  on public.work_order_catalog_selections
  for insert to authenticated
  with check (
    (select private.is_my_work_order(work_order_id))
    and shop_id = (select w.shop_id from public.work_orders w where w.id = work_order_id)
  );

-- UPDATE: valor/nota de selecciones de mis órdenes. El WITH CHECK impide
-- re-apuntar la fila a una orden que no sea mía.
create policy work_order_catalog_selections_tech_update
  on public.work_order_catalog_selections
  for update to authenticated
  using ((select private.is_my_work_order(work_order_id)))
  with check ((select private.is_my_work_order(work_order_id)));

-- DELETE: destildar trabajos de mis órdenes.
create policy work_order_catalog_selections_tech_delete
  on public.work_order_catalog_selections
  for delete to authenticated
  using ((select private.is_my_work_order(work_order_id)));

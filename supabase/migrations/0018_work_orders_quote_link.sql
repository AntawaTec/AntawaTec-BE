-- =============================================================================
-- 0018_work_orders_quote_link.sql
-- Enlace directo orden de trabajo -> cotización (work_orders.quote_id), con guard
-- de tenancy DECLARATIVO vía FK compuesto.
--
-- Por qué el FK compuesto y no uno simple: la policy RLS de work_orders es
-- column-agnostic (apply_tenant_rls solo valida shop_id = current_shop_id()),
-- así que un dueño del taller A podría setear quote_id apuntando a una cotización
-- del taller B y RLS lo dejaría pasar — el join luego devolvería null en silencio.
-- El FK (quote_id, shop_id) -> quotes(id, shop_id) exige que la cotización sea del
-- MISMO taller, cerrando el hueco que RLS no tapa. (Verificado: work_orders usa
-- apply_tenant_rls en 0007, no necesita cambios de RLS por esta columna nullable.)
--
-- SIN unique en work_orders.quote_id: una cotización puede generar varias órdenes
-- (redo / garantía), a propósito.
--
-- El backstop 1:1 de citas (unique parcial sobre appointments.quote_id) NO va aquí:
-- es otro concern (hardening del flujo de aprobación, TODO de quotes.ts:295) y es el
-- único con riesgo sobre datos existentes, así que vive aislado en 0019.
-- =============================================================================

-- 1) Tenancy guard: para referenciar (id, shop_id) desde el FK compuesto, quotes
--    necesita una UNIQUE sobre exactamente esas dos columnas. (id ya es PK, así que
--    esta unique es trivialmente satisfecha por los datos existentes.)
alter table public.quotes
  add constraint quotes_id_shop_key unique (id, shop_id);

-- 2) Enlace directo orden -> cotización (nullable: walk-in sin cotización = NULL).
alter table public.work_orders
  add column quote_id uuid;

-- 3) FK COMPUESTO (id, shop_id): garantiza que la cotización es del mismo taller.
--    ON DELETE SET NULL: borrar una cotización no arrastra la orden (en la práctica
--    solo se borran drafts, que nunca quedan enlazados). MATCH SIMPLE (default): las
--    filas existentes con quote_id NULL no se validan, así que el alter no falla.
alter table public.work_orders
  add constraint work_orders_quote_fk
  foreign key (quote_id, shop_id)
  references public.quotes (id, shop_id)
  on delete set null;

-- 4) Índice para el reporte cotizado-vs-consumido.
create index work_orders_quote_id_idx on public.work_orders (quote_id);

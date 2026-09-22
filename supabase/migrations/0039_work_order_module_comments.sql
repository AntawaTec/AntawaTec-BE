-- =============================================================================
-- 0039_work_order_module_comments.sql
-- Un comentario libre POR MÓDULO del catálogo (mantenimiento / reparación /
-- enderezada y pintura) dentro de una orden de trabajo.
--
-- POR QUÉ (pedido de Pablo, feedback de prod): "una opción Comentarios por cada
-- menú (mantenimiento, reparación, E&P) con espacio suficiente". Hoy el catálogo
-- (0025/0026/0030/0031/0035) es un árbol GLOBAL de `catalog_items` + filas de
-- `work_order_catalog_selections`: no hay forma de escribir un trabajo que NO
-- esté en el menú. `selections.notes` solo existe si el nodo fue tildado, así que
-- no sirve para "lo que se hizo además del menú" ni para una observación general
-- del bloque. Esta tabla es ese campo faltante.
--
-- REVIERTE (explícitamente) la decisión de 0025: "el comentario general por módulo
-- de Zoho (Comentarios_Mantenimientos) tampoco se modela: en V1 vive en las notas
-- de la orden/bitácora". Dos cosas la invalidaron:
--   1. Producto lo pidió con nombre y forma (un textarea por módulo, no una nota
--      suelta en la bitácora, que se pierde entre entradas cronológicas).
--   2. La migración de Zoho trae >1.000 comentarios libres por módulo
--      (`Comentarios_Mantenimientos1`, `Comentarios_Reparaciones`, …) que el
--      importador HOY no puede cargar en ningún lado sin aplastarlos todos en un
--      solo campo de la orden. Con esta tabla el import es 1:1 por módulo.
--
-- FORMA: una fila por (orden, módulo) — NO una por (orden, módulo, autor) ni un
-- hilo. Es el textarea de Zoho: el último que guarda pisa, igual que en la app
-- vieja. El FE lo renderiza en el resumen de la orden como una línea por módulo,
-- "  Comentarios: …", debajo de los trabajos tildados de ese módulo.
--
-- Tenancy: mismo patrón que 0025/0027 — `shop_id` denormalizado + FK COMPUESTO
-- (work_order_id, shop_id) para que un comentario no pueda colgarse de una orden
-- de OTRO taller (la RLS es column-agnostic y no valida FKs cross-tenant).
-- =============================================================================

create table public.work_order_module_comments (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  work_order_id uuid not null,
  module        public.catalog_module not null,
  comment       text not null,
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Sin comentarios vacíos ni de puros espacios: "no hay comentario" se expresa
  -- BORRANDO la fila, no guardando "". Así el resumen no imprime
  -- "  Comentarios:" colgando y el import de Zoho no arrastra celdas en blanco.
  constraint work_order_module_comments_comment_ck
    check (length(btrim(comment)) > 0),
  -- UNO por módulo (es un textarea, no un hilo). Nombre EXPLÍCITO (convención
  -- 0011): el FE distingue el 23505 por nombre de constraint y lo traduce a
  -- "ya hay un comentario para este módulo, recargá" en vez de un error crudo.
  -- El upsert del FE va con onConflict sobre estas mismas dos columnas.
  constraint work_order_module_comments_wo_module_unique
    unique (work_order_id, module),
  -- FK COMPUESTO (lección de 0018, igual que 0025/0027): exige que la orden sea
  -- del MISMO shop que la fila. Un FK simple dejaría adjuntar comentarios a
  -- órdenes ajenas (el WITH CHECK de apply_tenant_rls solo mira el shop_id
  -- propio) y filtraría la existencia de UUIDs de órdenes de otros talleres.
  -- Apoya en work_orders_id_shop_key (unique creado en 0025).
  constraint work_order_module_comments_wo_fk
    foreign key (work_order_id, shop_id) references public.work_orders (id, shop_id)
    on delete cascade
);

-- El unique (work_order_id, module) YA sirve los lookups por work_order_id
-- (prefijo izquierdo) y el chequeo del FK compuesto: no se crea un índice
-- separado sobre work_order_id, mismo argumento que en 0025 con
-- work_order_catalog_selections_unique. Tampoco hace falta uno por shop_id:
-- la consulta siempre entra por la orden (la RLS filtra, no busca).

create trigger set_work_order_module_comments_updated_at
  before update on public.work_order_module_comments
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS
-- =====================================================================

-- Tenant estándar: el dueño hace CRUD sobre su shop_id, el admin lee cross-shop.
select private.apply_tenant_rls('work_order_module_comments');

-- Carve-out ADITIVO del técnico, calcado de 0030 (escritura del catálogo en SUS
-- órdenes). Ninguna política owner/admin se toca: como current_shop_id() es NULL
-- para técnicos (0021), las genéricas ya los niegan y estas les devuelven SOLO
-- los comentarios de órdenes donde technician_id = su id.
--
-- Van las CUATRO operaciones porque el comentario es del mismo bloque de UI que
-- los trabajos del catálogo que el técnico ya puede editar (0030): si puede
-- tildar "Cambio de bujías" pero no escribir "faltó la bujía #3", el pedido de
-- Pablo queda a medias para quien efectivamente hace el trabajo. Borrar = vaciar
-- el textarea (ver el CHECK de arriba).

-- INSERT: solo en mis órdenes, y el shop_id denormalizado debe ser el de la
-- orden — el técnico no puede inventar un shop_id ajeno aunque la orden sea suya
-- (mismo candado que work_order_catalog_selections_tech_insert en 0030 y
-- work_order_logs_tech_insert en 0022; current_shop_id() no sirve acá: es NULL).
create policy work_order_module_comments_tech_insert
  on public.work_order_module_comments
  for insert to authenticated
  with check (
    (select private.is_my_work_order(work_order_id))
    and shop_id = (select w.shop_id from public.work_orders w where w.id = work_order_id)
  );

create policy work_order_module_comments_tech_select
  on public.work_order_module_comments
  for select to authenticated
  using ((select private.is_my_work_order(work_order_id)));

-- El WITH CHECK impide re-apuntar la fila a una orden que no sea mía.
create policy work_order_module_comments_tech_update
  on public.work_order_module_comments
  for update to authenticated
  using ((select private.is_my_work_order(work_order_id)))
  with check ((select private.is_my_work_order(work_order_id)));

create policy work_order_module_comments_tech_delete
  on public.work_order_module_comments
  for delete to authenticated
  using ((select private.is_my_work_order(work_order_id)));

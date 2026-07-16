-- =============================================================================
-- 0025_work_catalog.sql
-- Catálogo de menús de trabajo: reemplaza el checklist manual de Zoho
-- (Mantenimiento / Reparación / Enderezada y Pintura) por un único modelo de
-- árbol. Cada nodo es seleccionable (boolean o enum_select) y puede tener
-- hijos — no hay distinción de "categoría" vs "hoja": un nodo puede ser
-- checkbox Y padre a la vez (así se comporta Zoho: tildar un padre revela
-- sus hijos).
--
-- FASE 1: solo se siembra el módulo Mantenimiento. Reparación (14 categorías,
-- 2-4 niveles) y Enderezada y Pintura (40+ partes) se siembran en una
-- migración futura SOLO-SEED, sin tocar este schema.
--
-- CONVENCIÓN DE MODELADO para la fase 2 (Enderezada y Pintura) — importante,
-- el encoding NO es intercambiable:
--   * Las acciones de una parte principal (RR / REP / Pintura) son CHECKBOXES
--     COMBINABLES en Zoho ("enderezar Y pintar" es el caso típico del rubro)
--     → se siembran como HIJOS boolean del nodo-parte. Parabrisas y Faros
--     solo llevan RR y REP (no tienen Pintura).
--   * enum_select queda EXCLUSIVO para los dropdowns "-Seleccionar-" de
--     opción ÚNICA de los sub-componentes (ej. Mascarilla, Emblema), con
--     enum_options = {RR,REP,Pintura}.
--
-- Otras decisiones (memoria de sesión antawa-catalogo-menus-diseno):
--   - Catálogo GLOBAL, no por-taller: sin shop_id en catalog_items, solo
--     lectura para authenticated. Sin políticas de escritura — el árbol se
--     siembra por migración / service_role, nadie lo edita desde la app en V1.
--   - Se persiste el detalle COMPLETO de selección (cualquier profundidad),
--     a diferencia de Zoho que solo guarda el resumen nivel-1 en la orden.
--   - `notes` vive en la fila de selección — reemplaza los campos de
--     comentario hardcodeados por rama de Zoho. Por eso el checkbox
--     "Comentarios" que Zoho muestra dentro de "ABC del motor" se OMITE
--     deliberadamente del seed: es un artefacto de UI (revelaba un textarea),
--     no un trabajo. Fase 2: NO transcribir los checkboxes/textareas de
--     comentarios por rama — `notes` los cubre.
--   - El comentario general por módulo de Zoho ("Comentarios_Mantenimientos")
--     tampoco se modela: en V1 vive en las notas de la orden/bitácora. No
--     insertar filas de selección "solo-nota".
--   - Invariante "hijo seleccionado ⇒ padre seleccionado": lo garantiza la
--     UI (el árbol de checkboxes fuerza el flujo), no la DB. Los reportes
--     deben tratar al padre como implícito si aparece un hijo.
--   - Técnicos (0021/0022): SELECT aditivo sobre las selecciones de SUS
--     órdenes (el checklist es lo que ejecutan); la escritura queda
--     owner-only en V1, como inventory_movements/deliveries.
--   - IDs del seed DETERMINISTAS (UUIDs literales, como el seed de shops):
--     el tooling de import de Zoho y los fixtures del FE mapean
--     picklist→catalog_item_id igual en local/staging/prod. Los nombres se
--     repiten entre ramas ("Delantero"/"Posterior"), así que (module, name)
--     no es una clave utilizable.
--   - Texto de nodos transcripto LITERAL de Zoho, incluye inconsistencias
--     reales ("aceites diferenciales", "batería" en minúscula, "Cables
--     bujias" sin tilde) — normalizar es una decisión aparte, no tomada.
-- =============================================================================

create type public.catalog_module         as enum ('mantenimiento', 'reparacion', 'enderezada_pintura');
create type public.catalog_selection_type as enum ('boolean', 'enum_select');

create table public.catalog_items (
  id              uuid primary key default gen_random_uuid(),
  module          public.catalog_module not null,
  parent_id       uuid,
  name            text not null,
  selection_type  public.catalog_selection_type not null default 'boolean',
  enum_options    text[],   -- SOLO enum_select (dropdowns mono-valor de sub-componentes)
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  -- Disyunción total sin fuga de NULL (un CHECK que evalúa a NULL pasa;
  -- array_length('{}') es NULL, cardinality('{}') es 0):
  constraint catalog_items_enum_options_ck check (
    (selection_type = 'enum_select' and enum_options is not null and cardinality(enum_options) > 0)
    or (selection_type = 'boolean' and enum_options is null)
  ),
  constraint catalog_items_no_self_parent_ck check (parent_id <> id),
  -- unique redundante con el PK pero requerido por el self-FK compuesto de
  -- abajo (mismo truco que quotes_id_shop_key en 0018).
  constraint catalog_items_id_module_key unique (id, module),
  -- Self-FK COMPUESTO: un hijo no puede colgar de un padre de OTRO módulo
  -- (el seed de fase 2 es grande y manual; esto lo hace imposible por typo).
  -- MATCH SIMPLE: parent_id NULL (raíces) no se valida.
  constraint catalog_items_parent_fk
    foreign key (parent_id, module) references public.catalog_items (id, module)
    on delete cascade
);
create index catalog_items_parent_id_idx on public.catalog_items (parent_id);
create index catalog_items_module_idx    on public.catalog_items (module);
-- Protege los seeds futuros de duplicar hermanos en silencio. NULLS NOT
-- DISTINCT: dos raíces del mismo módulo con el mismo nombre también chocan.
create unique index catalog_items_sibling_name_uq
  on public.catalog_items (module, parent_id, name) nulls not distinct;

-- Tenancy guard para el FK compuesto de selections (mismo patrón y mismo
-- argumento que 0018 con quotes: id ya es PK, el unique es trivialmente
-- satisfecho por los datos existentes).
alter table public.work_orders
  add constraint work_orders_id_shop_key unique (id, shop_id);

-- Selección de catálogo por orden: una fila por nodo elegido, a cualquier
-- profundidad. `selected_value` solo aplica a hojas enum_select (validado
-- por trigger, ver abajo); las boolean solo necesitan existir (la fila =
-- seleccionado).
create table public.work_order_catalog_selections (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  work_order_id   uuid not null,
  catalog_item_id uuid not null references public.catalog_items(id) on delete restrict,
  selected_value  text,
  notes           text,
  created_by      uuid references auth.users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  -- FK COMPUESTO (lección de 0018): la policy de apply_tenant_rls es
  -- column-agnostic (solo valida el shop_id de la fila propia), así que un
  -- FK simple dejaría adjuntar selecciones a órdenes de OTRO taller. Este FK
  -- exige que la orden sea del MISMO shop. Cierra también el oráculo de
  -- existencia de UUIDs de órdenes ajenas.
  constraint work_order_catalog_selections_wo_fk
    foreign key (work_order_id, shop_id) references public.work_orders (id, shop_id)
    on delete cascade
);
-- El unique compuesto cubre los lookups por work_order_id (prefijo
-- izquierdo) — no hace falta índice aparte sobre esa columna. El de
-- catalog_item_id sí: no es prefijo y el ON DELETE RESTRICT lo usa.
create unique index work_order_catalog_selections_unique
  on public.work_order_catalog_selections (work_order_id, catalog_item_id);
create index work_order_catalog_selections_item_idx
  on public.work_order_catalog_selections (catalog_item_id);

create trigger set_work_order_catalog_selections_updated_at
  before update on public.work_order_catalog_selections
  for each row execute function public.set_updated_at();

-- Validación cross-tabla que un CHECK no puede expresar (principio #1 del
-- repo: la integridad es garantía de la DB, no de la app): boolean ⇒ sin
-- valor; enum_select ⇒ valor obligatorio y dentro de enum_options.
create or replace function private.validate_catalog_selection()
returns trigger
language plpgsql
as $$
declare
  v_type    public.catalog_selection_type;
  v_options text[];
begin
  select selection_type, enum_options into v_type, v_options
    from public.catalog_items where id = new.catalog_item_id;
  if v_type = 'boolean' and new.selected_value is not null then
    raise exception 'selected_value debe ser NULL para un ítem boolean'
      using errcode = '23514';
  end if;
  if v_type = 'enum_select'
     and (new.selected_value is null or not new.selected_value = any (v_options)) then
    raise exception 'selected_value "%" inválido: las opciones del ítem son %',
      new.selected_value, v_options
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger validate_work_order_catalog_selection
  before insert or update on public.work_order_catalog_selections
  for each row execute function private.validate_catalog_selection();

-- =====================================================================
-- RLS
-- =====================================================================

-- catalog_items es global (sin shop_id): lectura para cualquier
-- authenticated (incluye técnicos y admin — lo necesitan para renderizar),
-- SIN políticas de escritura (sin política = sin acceso; se siembra por
-- migración / service_role).
alter table public.catalog_items enable row level security;
create policy catalog_items_select on public.catalog_items
  for select to authenticated
  using (true);

-- selections es tenant-scoped estándar…
select private.apply_tenant_rls('work_order_catalog_selections');

-- …más el carve-out aditivo del técnico (patrón 0022): SELECT sobre las
-- selecciones de SUS órdenes asignadas — el checklist es lo que ejecuta.
-- Escritura owner-only en V1 (mismo criterio que inventory_movements y
-- deliveries en 0022; follow-up aditivo si producto lo pide).
create policy work_order_catalog_selections_tech_select
  on public.work_order_catalog_selections
  for select to authenticated
  using ((select private.is_my_work_order(work_order_id)));

-- =====================================================================
-- SEED — módulo Mantenimiento (fase 1).
-- Transcripción literal de las capturas de Zoho (sin el checkbox
-- "Comentarios" de Motor Abc — ver header). UUIDs deterministas
-- c1…NN = módulo mantenimiento, correlativos en orden de UI.
-- =====================================================================
insert into public.catalog_items (id, module, parent_id, name, selection_type, sort_order) values
  -- 12 ítems de la grilla principal
  ('c1000000-0000-4000-8000-000000000001', 'mantenimiento', null, 'Aceite y filtro de motor',  'boolean', 1),
  ('c1000000-0000-4000-8000-000000000002', 'mantenimiento', null, 'Aceite de caja de cambios', 'boolean', 2),
  ('c1000000-0000-4000-8000-000000000003', 'mantenimiento', null, 'aceites diferenciales',     'boolean', 3),
  ('c1000000-0000-4000-8000-000000000004', 'mantenimiento', null, 'Traslado aceite 4x4',       'boolean', 4),
  ('c1000000-0000-4000-8000-000000000005', 'mantenimiento', null, 'ABC del motor',             'boolean', 5),
  ('c1000000-0000-4000-8000-000000000006', 'mantenimiento', null, 'Refrigerante',              'boolean', 6),
  ('c1000000-0000-4000-8000-000000000007', 'mantenimiento', null, 'Líquido de Frenos',         'boolean', 7),
  ('c1000000-0000-4000-8000-000000000008', 'mantenimiento', null, 'Bandas y Templadores',      'boolean', 8),
  ('c1000000-0000-4000-8000-000000000009', 'mantenimiento', null, 'Banda Distribución',        'boolean', 9),
  ('c1000000-0000-4000-8000-000000000010', 'mantenimiento', null, 'Alineación y Equilibrio',   'boolean', 10),
  ('c1000000-0000-4000-8000-000000000011', 'mantenimiento', null, 'batería',                   'boolean', 11),
  ('c1000000-0000-4000-8000-000000000012', 'mantenimiento', null, 'Reajuste general',          'boolean', 12),
  -- hijos de "aceites diferenciales"
  ('c1000000-0000-4000-8000-000000000013', 'mantenimiento', 'c1000000-0000-4000-8000-000000000003', 'Delantero', 'boolean', 1),
  ('c1000000-0000-4000-8000-000000000014', 'mantenimiento', 'c1000000-0000-4000-8000-000000000003', 'Posterior', 'boolean', 2),
  -- hijos de "ABC del motor" (sub-bloque "Motor Abc" en Zoho)
  ('c1000000-0000-4000-8000-000000000015', 'mantenimiento', 'c1000000-0000-4000-8000-000000000005', 'Filtro de aire',               'boolean', 1),
  ('c1000000-0000-4000-8000-000000000016', 'mantenimiento', 'c1000000-0000-4000-8000-000000000005', 'Filtro de combustible',        'boolean', 2),
  ('c1000000-0000-4000-8000-000000000017', 'mantenimiento', 'c1000000-0000-4000-8000-000000000005', 'Filtro de aire acondicionado', 'boolean', 3),
  ('c1000000-0000-4000-8000-000000000018', 'mantenimiento', 'c1000000-0000-4000-8000-000000000005', 'Bujías',                       'boolean', 4),
  ('c1000000-0000-4000-8000-000000000019', 'mantenimiento', 'c1000000-0000-4000-8000-000000000005', 'Cables bujias',                'boolean', 5);

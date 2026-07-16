-- =============================================================================
-- 0025_work_catalog.sql
-- Catálogo de menús de trabajo: reemplaza el checklist manual de Zoho
-- (Mantenimiento / Reparación / Enderezada y Pintura) por un único modelo de
-- árbol. Cada nodo es seleccionable (boolean o enum_select) y puede tener
-- hijos — no hay distinción de "categoría" vs "hoja": un nodo nivel-1 puede
-- ser checkbox Y padre de nivel-2 al mismo tiempo (así se comporta Zoho).
--
-- FASE 1: solo se siembra el módulo Mantenimiento (12 ítems, 2 con nivel-3).
-- Reparación (14 categorías) y Enderezada y Pintura (40+ partes) quedan con el
-- tipo listo — su seed va en una migración siguiente una vez validado el
-- modelo en UI (decisión del user, ver memoria de sesión
-- antawa-catalogo-menus-diseno).
--
-- Otras decisiones tomadas (mismo memo):
--   - Catálogo GLOBAL, no por-taller: sin shop_id en catalog_items, solo
--     lectura para authenticated. Sin políticas de insert/update/delete —
--     nadie edita el árbol desde la app en V1, se siembra por migración.
--   - Se persiste el detalle COMPLETO de selección (cualquier profundidad),
--     a diferencia de Zoho que solo guarda el resumen nivel-1 en la orden
--     (limitación confirmada viendo el video de uso real).
--   - `notes` vive en la fila de selección, no como campos fijos por rama
--     (Zoho tiene "Comentarios_Mantenimientos", "Comentarios sobre el motor
--     abc" hardcodeados) — más general: cualquier nodo seleccionado puede
--     llevar una nota.
--   - Texto de nodos transcripto LITERAL de Zoho, incluye inconsistencias
--     reales de mayúsculas/tildes ("aceites diferenciales", "batería" en
--     minúscula, "Cables bujias" sin tilde) — normalizar es una decisión
--     aparte, no tomada todavía.
-- =============================================================================

create type public.catalog_module         as enum ('mantenimiento', 'reparacion', 'enderezada_pintura');
create type public.catalog_selection_type as enum ('boolean', 'enum_select');

create table public.catalog_items (
  id              uuid primary key default gen_random_uuid(),
  module          public.catalog_module not null,
  parent_id       uuid references public.catalog_items(id) on delete cascade,
  name            text not null,
  selection_type  public.catalog_selection_type not null default 'boolean',
  enum_options    text[],   -- solo enum_select, ej. {RR,REP,Pintura}
  sort_order      int not null default 0,
  created_at      timestamptz not null default now(),
  constraint catalog_items_enum_options_ck check (
    (selection_type = 'enum_select')
    = (enum_options is not null and array_length(enum_options, 1) > 0)
  )
);
create index catalog_items_parent_id_idx on public.catalog_items (parent_id);
create index catalog_items_module_idx    on public.catalog_items (module);

-- Selección de catálogo por orden: una fila por nodo elegido, a cualquier
-- profundidad. `selected_value` solo aplica a hojas enum_select (ej. 'REP');
-- las boolean solo necesitan existir (la fila = seleccionado).
create table public.work_order_catalog_selections (
  id              uuid primary key default gen_random_uuid(),
  shop_id         uuid not null references public.shops(id) on delete cascade,
  work_order_id   uuid not null references public.work_orders(id) on delete cascade,
  catalog_item_id uuid not null references public.catalog_items(id) on delete restrict,
  selected_value  text,
  notes           text,
  created_at      timestamptz not null default now()
);
create index work_order_catalog_selections_wo_idx   on public.work_order_catalog_selections (work_order_id);
create index work_order_catalog_selections_item_idx on public.work_order_catalog_selections (catalog_item_id);
create unique index work_order_catalog_selections_unique
  on public.work_order_catalog_selections (work_order_id, catalog_item_id);

-- RLS — catalog_items es global (sin shop_id): lectura para cualquier
-- authenticated, SIN políticas de insert/update/delete (sin política = sin
-- acceso; se siembra por migración / service_role).
alter table public.catalog_items enable row level security;
create policy catalog_items_select on public.catalog_items
  for select to authenticated
  using (true);

-- work_order_catalog_selections es tenant-scoped estándar.
select private.apply_tenant_rls('work_order_catalog_selections');

-- =====================================================================
-- SEED — módulo Mantenimiento (fase 1).
-- Transcripción literal de las capturas de Zoho (ver memoria de sesión).
-- =====================================================================
do $$
declare
  v_aceites_dif uuid;
  v_abc_motor   uuid;
begin
  insert into public.catalog_items (module, name, selection_type, sort_order) values
    ('mantenimiento', 'Aceite y filtro de motor', 'boolean', 1),
    ('mantenimiento', 'Aceite de caja de cambios', 'boolean', 2);

  insert into public.catalog_items (module, name, selection_type, sort_order)
    values ('mantenimiento', 'aceites diferenciales', 'boolean', 3)
    returning id into v_aceites_dif;

  insert into public.catalog_items (module, parent_id, name, selection_type, sort_order) values
    ('mantenimiento', v_aceites_dif, 'Delantero', 'boolean', 1),
    ('mantenimiento', v_aceites_dif, 'Posterior', 'boolean', 2);

  insert into public.catalog_items (module, name, selection_type, sort_order)
    values ('mantenimiento', 'Traslado aceite 4x4', 'boolean', 4);

  insert into public.catalog_items (module, name, selection_type, sort_order)
    values ('mantenimiento', 'ABC del motor', 'boolean', 5)
    returning id into v_abc_motor;

  insert into public.catalog_items (module, parent_id, name, selection_type, sort_order) values
    ('mantenimiento', v_abc_motor, 'Filtro de aire', 'boolean', 1),
    ('mantenimiento', v_abc_motor, 'Filtro de combustible', 'boolean', 2),
    ('mantenimiento', v_abc_motor, 'Filtro de aire acondicionado', 'boolean', 3),
    ('mantenimiento', v_abc_motor, 'Bujías', 'boolean', 4),
    ('mantenimiento', v_abc_motor, 'Cables bujias', 'boolean', 5),
    ('mantenimiento', v_abc_motor, 'Comentarios', 'boolean', 6);

  insert into public.catalog_items (module, name, selection_type, sort_order) values
    ('mantenimiento', 'Refrigerante', 'boolean', 6),
    ('mantenimiento', 'Líquido de Frenos', 'boolean', 7),
    ('mantenimiento', 'Bandas y Templadores', 'boolean', 8),
    ('mantenimiento', 'Banda Distribución', 'boolean', 9),
    ('mantenimiento', 'Alineación y Equilibrio', 'boolean', 10),
    ('mantenimiento', 'batería', 'boolean', 11),
    ('mantenimiento', 'Reajuste general', 'boolean', 12);
end $$;

-- =============================================================================
-- 0027_work_time_logs.sql
-- Timer de productividad de técnicos: sesiones de trabajo inicio→fin por orden
-- y técnico. Reemplaza (y supera) lo que Zoho registraba: Zoho guardaba
-- timestamps por orden agrupados por técnico SIN ningún agregado; acá el FE
-- calcula productividad real (total por técnico, órdenes tocadas) sobre estas
-- filas. Semántica del timer: pausa = cerrar la sesión (ended_at), reanudar =
-- abrir una nueva; el total es la SUMA de sesiones. NULL en ended_at = sesión
-- corriendo.
--
-- Decisiones:
--   - started_at y ended_at son hora del servidor: el insert no manda
--     started_at (default now()) y el cierre va por la RPC stop_work_time_log
--     (now() del server). Los relojes de los teléfonos no son fuente de verdad
--     para medir productividad. Para el TÉCNICO es un invariante (su policy de
--     insert exige started_at = now() y ended_at null); para el owner es
--     convención del FE (corregir registros es suyo, como el no-DELETE técnico).
--   - UNA sesión corriendo por técnico (unique parcial): un técnico no trabaja
--     dos órdenes a la vez; el 23505 llega con nombre de índice explícito para
--     que el FE lo traduzca ("ya tiene una sesión corriendo en otra orden").
--   - La RPC NO es idempotente a propósito: cerrar una sesión ya cerrada (otra
--     pestaña / el owner se adelantó) devuelve P0002 — bajo RLS "no existe",
--     "no es tuya" y "ya estaba cerrada" son indistinguibles (0 filas), así que
--     es un solo error honesto que el FE traduce y recarga.
--   - FK del técnico con NO ACTION (default), NO restrict: al borrar un shop,
--     el cascade shops→technicians dispara antes que shops→work_order_time_logs
--     (los triggers RI corren en orden de creación) y RESTRICT chequea
--     inmediato → el wipe del taller fallaría. NO ACTION chequea al final del
--     statement, cuando el cascade por shop_id ya vació las sesiones. Borrar un
--     técnico directo sigue bloqueado (y la app nunca borra técnicos:
--     setTechnicianActive solamente).
--   - NO acoplado al status de la orden (mismo principio que el consumo de
--     inventario: acción independiente, el taller decide cuándo).
--   - Residuales aceptados (documentados, sin superficie en el FE): la RLS es
--     column-agnostic, así que un técnico podría EDITAR (update) los timestamps
--     de SU propia sesión o moverla a otra orden de su MISMO taller — confianza
--     intra-taller. Los FKs compuestos cierran la ESCRITURA cross-tenant; en
--     LECTURA persiste un residual heredado de 0021/0022 (no de esta tabla):
--     work_orders.technician_id es FK simple (0007), así que un owner podría
--     asignar su orden a un uuid de técnico ajeno y ese técnico la vería (y sus
--     time logs). Follow-up de raíz: FK compuesto en work_orders.technician_id
--     usando el unique technicians_id_shop_key que ESTA migración crea.
--   - Follow-up (no V1): guard de "sesión olvidada" (auto-cierre nocturno o
--     alerta de duración máxima).
-- =============================================================================

-- Tenancy guard para el FK compuesto del técnico (mismo argumento trivial que
-- 0018/0025: id ya es PK, el unique lo satisfacen los datos existentes).
alter table public.technicians
  add constraint technicians_id_shop_key unique (id, shop_id);

create table public.work_order_time_logs (
  id            uuid primary key default gen_random_uuid(),
  shop_id       uuid not null references public.shops(id) on delete cascade,
  work_order_id uuid not null,
  technician_id uuid not null,
  started_at    timestamptz not null default now(),  -- hora del SERVER; el FE no la manda
  ended_at      timestamptz,                          -- NULL = sesión corriendo
  created_by    uuid references auth.users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- Sin fuga de NULL: ended_at NULL → primer disyunto true; started_at es
  -- NOT NULL, así que el segundo disyunto nunca evalúa a NULL.
  constraint work_order_time_logs_span_ck check (ended_at is null or ended_at > started_at),
  -- FKs COMPUESTOS (lección de 0018): la policy de apply_tenant_rls es
  -- column-agnostic; sin esto se podría colgar una sesión de una orden o un
  -- técnico de OTRO taller.
  constraint work_order_time_logs_wo_fk
    foreign key (work_order_id, shop_id) references public.work_orders (id, shop_id)
    on delete cascade,
  constraint work_order_time_logs_tech_fk
    foreign key (technician_id, shop_id) references public.technicians (id, shop_id)
);

-- UNA sesión corriendo por técnico, garantizada por la DB sin importar quién
-- inserta (owner o el propio técnico).
create unique index work_order_time_logs_running_uq
  on public.work_order_time_logs (technician_id) where ended_at is null;
-- Índice PLENO sobre technician_id: el unique parcial no sirve al chequeo del
-- FK ni a los lookups de sesiones cerradas (excluye ended_at not null).
create index work_order_time_logs_tech_idx on public.work_order_time_logs (technician_id);
create index work_order_time_logs_wo_idx   on public.work_order_time_logs (work_order_id);
-- Reporte de productividad (rango de fechas dentro del taller).
create index work_order_time_logs_shop_started_idx
  on public.work_order_time_logs (shop_id, started_at);

create trigger set_work_order_time_logs_updated_at
  before update on public.work_order_time_logs
  for each row execute function public.set_updated_at();

-- Cierre con hora del SERVER. SECURITY INVOKER: la RLS del caller gobierna —
-- el owner cierra las de su taller, el técnico solo las suyas (tech_update).
create or replace function public.stop_work_time_log(p_id uuid)
returns public.work_order_time_logs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.work_order_time_logs;
begin
  update public.work_order_time_logs
     set ended_at = now()
   where id = p_id and ended_at is null
  returning * into v_row;
  if not found then
    raise exception 'stop_work_time_log: la sesión no existe, no es tuya o ya estaba cerrada'
      using errcode = 'P0002';
  end if;
  return v_row;
end;
$$;
-- Los default privileges de Supabase le dan EXECUTE a anon en toda función
-- nueva de `public` — el revoke de PUBLIC no alcanza (es un grant directo).
-- Sin esto anon podría invocarla (inofensivo bajo INVOKER+RLS, 0 filas → P0002,
-- pero superficie innecesaria).
revoke execute on function public.stop_work_time_log(uuid) from public, anon;
grant  execute on function public.stop_work_time_log(uuid) to authenticated;

-- =====================================================================
-- RLS
-- =====================================================================

-- Tenant estándar: owner CRUD su shop, admin lectura cross-shop.
select private.apply_tenant_rls('work_order_time_logs');

-- Carve-out aditivo del técnico (patrón 0022). current_shop_id() es NULL para
-- técnicos → las políticas genéricas los niegan; se devuelve SOLO lo necesario.
-- SELECT: las de MIS órdenes (ver qué se trabajó en ellas, incluso de otros
-- técnicos) O las MÍAS aunque la orden ya no sea mía. El segundo disyunto no
-- es opcional: en Postgres, un UPDATE cuyo WHERE/RETURNING lee la tabla exige
-- pasar TAMBIÉN las policies de SELECT — sin él, el técnico saliente tras una
-- reasignación no podría cerrar su sesión corriendo (la RPC daría P0002), no
-- podría verla, y el unique parcial le bloquearía iniciar cualquier otra.
create policy work_order_time_logs_tech_select on public.work_order_time_logs
  for select to authenticated
  using (
    technician_id = (select private.current_technician_id())
    or (select private.is_my_work_order(work_order_id))
  );

create policy work_order_time_logs_tech_insert on public.work_order_time_logs
  for insert to authenticated
  with check (
    (select private.is_my_work_order(work_order_id))
    and shop_id = (select w.shop_id from public.work_orders w where w.id = work_order_id)
    -- No se cronometra a nombre de otro.
    and technician_id = (select private.current_technician_id())
    -- El técnico no fabrica sesiones: started_at debe ser EL now() de la tx
    -- (igual al default → un insert que omite ambas columnas pasa exacto) y
    -- nace corriendo. Sin esto podría insertar sesiones cerradas con
    -- timestamps arbitrarios e inflar su propia métrica de productividad.
    and started_at = now() and ended_at is null
  );

-- UPDATE por technician_id y NO por is_my_work_order: si la orden se reasigna
-- con una sesión corriendo, el técnico saliente debe poder cerrar LA SUYA
-- (la fila le sigue pasando el SELECT por el disyunto technician_id = mine).
create policy work_order_time_logs_tech_update on public.work_order_time_logs
  for update to authenticated
  using (technician_id = (select private.current_technician_id()))
  with check (technician_id = (select private.current_technician_id()));
-- Sin DELETE para técnicos (corregir errores es del owner).

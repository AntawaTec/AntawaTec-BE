-- =============================================================================
-- 0021_technician_identity.sql
-- Identidad del técnico: lo enlaza a un usuario de auth y define los helpers RLS.
-- Diseñado vía debate dual-Opus + verificación empírica contra el stack.
--
-- DECISIÓN CENTRAL (deny-by-default): private.current_shop_id() pasa a devolver
-- NULL para los técnicos. Semánticamente current_shop_id() = "el taller que el
-- usuario ADMINISTRA como dueño"; un técnico es MIEMBRO, no dueño. Como TODAS las
-- políticas genéricas (apply_tenant_rls en ~14 tablas + storage + RPCs) se
-- construyen sobre current_shop_id(), un técnico queda NEGADO por defecto en todo
-- el esquema sin tocar ninguna de esas políticas. El acceso del técnico se OTORGA
-- explícitamente, tabla por tabla, en 0022 (puramente aditivo). Esto también hace
-- que CUALQUIER tabla tenant futura sea automáticamente invisible al técnico hasta
-- que se le otorgue acceso — el default seguro.
-- (Alternativa rechazada: dejar current_shop_id() "honesto" → el técnico, con
--  shop_id real, matchearía las políticas genéricas y vería TODO el taller;
--  habría que editar las ~14 tablas para excluirlo. Verificado empíricamente.)
-- =============================================================================

-- 1) El constraint debe permitir technician con shop_id (pertenece a un taller).
alter table public.profiles drop constraint profiles_role_shop_ck;
alter table public.profiles add constraint profiles_role_shop_ck check (
  (role = 'antawa_admin' and shop_id is null)
  or (role in ('shop_owner', 'technician') and shop_id is not null)
);

-- 2) Enlace técnico ↔ login. Nullable: un técnico puede ser staff SIN login (el
--    default de V1). on delete set null: revocar el login degrada al técnico a
--    staff sin login, no borra su historial de órdenes.
alter table public.technicians
  add column profile_id uuid references public.profiles(id) on delete set null;
create unique index technicians_profile_id_uk
  on public.technicians (profile_id) where profile_id is not null; -- 1 login ↔ ≤1 técnico
create index technicians_profile_id_idx on public.technicians (profile_id);

-- 3) Redefinir current_shop_id(): NULL para técnicos (deny-by-default). Mismo
--    shape que 0002 (SECURITY DEFINER, search_path='', stable) — solo cambia el body.
create or replace function private.current_shop_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case when role = 'technician' then null else shop_id end
  from public.profiles
  where id = (select auth.uid());
$$;

-- 4) Helper: el technicians.id del técnico logueado (NULL si no es técnico/sin link).
create or replace function private.current_technician_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from public.technicians where profile_id = (select auth.uid());
$$;

-- 5) Helper: ¿la orden p_id está asignada al técnico logueado? SECURITY DEFINER
--    (salta RLS sobre work_orders → sin recursión cuando las políticas de las
--    tablas hijas lo invocan). Chokepoint de visibilidad reusado por logs/media.
create or replace function private.is_my_work_order(p_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.work_orders
    where id = p_id
      and technician_id = (select private.current_technician_id())
  );
$$;

revoke execute on function private.current_technician_id()    from public;
revoke execute on function private.is_my_work_order(uuid)     from public;
grant  execute on function private.current_technician_id()    to authenticated;
grant  execute on function private.is_my_work_order(uuid)     to authenticated;

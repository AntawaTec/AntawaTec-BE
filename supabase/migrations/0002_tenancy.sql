-- =============================================================================
-- 0002_tenancy.sql
-- Tenant root (shops), user profiles, shop staff (technicians).
-- Defines the RLS helper functions and the standard tenant-isolation pattern
-- that every operational table reuses.
-- =============================================================================

-- =====================================================================
-- TABLES
-- =====================================================================

-- The tenant. One row per shop. Created by provisioning (service role),
-- never inserted by an end user.
create table public.shops (
  id                   uuid primary key default gen_random_uuid(),
  name                 text not null,
  slug                 text not null unique,
  status               public.shop_status not null default 'pending',
  contact_email        text,
  contact_phone        text,
  subscription_status  text,
  activated_at         timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- Maps an auth.users row to a role and (for shop owners) a shop.
-- antawa_admin => shop_id IS NULL (cross-shop). shop_owner => one shop.
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  shop_id     uuid references public.shops(id) on delete cascade,
  role        public.user_role not null default 'shop_owner',
  full_name   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profiles_role_shop_ck check (
    (role = 'antawa_admin' and shop_id is null)
    or (role = 'shop_owner' and shop_id is not null)
  )
);
create index profiles_shop_id_idx on public.profiles (shop_id);

-- Shop staff. NOT auth users in V1 (decision recorded in CLAUDE.md).
create table public.technicians (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  full_name   text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index technicians_shop_id_idx on public.technicians (shop_id);

-- =====================================================================
-- RLS HELPER FUNCTIONS  (profiles now exists, so bodies validate)
-- SECURITY DEFINER => they bypass RLS on profiles, which prevents the
-- recursive-policy problem when policies on other tables call them, and
-- when policies on profiles itself need an admin check.
-- =====================================================================

create or replace function private.current_shop_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select shop_id from public.profiles where id = (select auth.uid());
$$;

create or replace function private.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'antawa_admin'
  );
$$;

revoke execute on function private.current_shop_id()   from public;
revoke execute on function private.is_platform_admin() from public;
grant  execute on function private.current_shop_id()   to authenticated;
grant  execute on function private.is_platform_admin() to authenticated;

-- =====================================================================
-- STANDARD TENANT-ISOLATION POLICY GENERATOR
-- Applies the canonical policy set to any table that has a shop_id column:
--   - shop owners get full CRUD scoped to their own shop
--   - platform admins get read access across all shops (writes go through
--     the service role, e.g. migration import scripts)
-- Reused by every operational domain migration (0003+).
-- DDL helper: only ever called at migration time by a privileged role.
-- =====================================================================
create or replace function private.apply_tenant_rls(tbl text)
returns void
language plpgsql
as $fn$
begin
  execute format('alter table public.%I enable row level security;', tbl);

  execute format(
    'create policy %I on public.%I for select to authenticated '
    'using (shop_id = (select private.current_shop_id()) '
    '       or (select private.is_platform_admin()));',
    tbl || '_select', tbl);

  execute format(
    'create policy %I on public.%I for insert to authenticated '
    'with check (shop_id = (select private.current_shop_id()));',
    tbl || '_insert', tbl);

  execute format(
    'create policy %I on public.%I for update to authenticated '
    'using (shop_id = (select private.current_shop_id())) '
    'with check (shop_id = (select private.current_shop_id()));',
    tbl || '_update', tbl);

  execute format(
    'create policy %I on public.%I for delete to authenticated '
    'using (shop_id = (select private.current_shop_id()));',
    tbl || '_delete', tbl);
end;
$fn$;

revoke execute on function private.apply_tenant_rls(text) from public;

-- =====================================================================
-- updated_at TRIGGERS
-- =====================================================================
create trigger set_shops_updated_at
  before update on public.shops
  for each row execute function public.set_updated_at();

create trigger set_profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

create trigger set_technicians_updated_at
  before update on public.technicians
  for each row execute function public.set_updated_at();

-- =====================================================================
-- RLS — base layer
-- shops & profiles are special cases (not standard shop_id-scoped),
-- so their policies are written explicitly. technicians is standard,
-- so it uses the generator.
-- =====================================================================

alter table public.shops    enable row level security;
alter table public.profiles enable row level security;

-- shops: owner reads only their own shop; admin reads all.
-- Creation/activation/edits are admin- or provisioning-driven.
create policy shops_select on public.shops
  for select to authenticated
  using ( id = (select private.current_shop_id())
          or (select private.is_platform_admin()) );

create policy shops_update on public.shops
  for update to authenticated
  using ( (select private.is_platform_admin()) )
  with check ( (select private.is_platform_admin()) );

-- profiles: a user reads/edits their own row; admin reads all.
-- No recursion: the admin check uses a SECURITY DEFINER helper.
-- Profiles are created by provisioning (service role); no insert policy.
create policy profiles_select on public.profiles
  for select to authenticated
  using ( id = (select auth.uid())
          or (select private.is_platform_admin()) );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using ( id = (select auth.uid()) )
  with check ( id = (select auth.uid()) );

-- technicians: standard tenant pattern.
select private.apply_tenant_rls('technicians');

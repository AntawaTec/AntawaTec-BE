-- =============================================================================
-- 0050_billing_fiscal_data.sql
-- Facturación electrónica SRI — datos fiscales del taller y del cliente, y la
-- credencial del proveedor por taller.
--
-- Cuatro piezas:
--   1. `shops.billing_enabled`: la activación POR TALLER la decide Antawa desde
--      /admin (UPDATE directo: la policy `shops_update` de 0002 ya es solo-admin).
--      El dueño no puede prenderla.
--   2. Datos fiscales OPCIONALES del cliente (`customers.id_type/id_number/address`).
--      Nullable y sin unique: hay ~650 clientes migrados de Zoho sin el dato, y la
--      factura guarda su propio snapshot del comprador (0051) — el cliente solo
--      prellena el editor.
--   3. `shop_billing_settings`: RUC, razón social, serie (establecimiento + punto
--      de emisión), régimen, ambiente y el estado de la empresa en el proveedor.
--      Dueño y admin la LEEN; NADIE la escribe desde el navegador: la escribe la
--      Edge Function `billing-setup` con service_role, porque cada cambio tiene que
--      reflejarse primero en el proveedor (AutorizadorEC). Así no se toca la RPC
--      `update_shop_settings` (cambiarle la firma exige DROP + CREATE, ver 0032).
--   4. La API key del proveedor POR TALLER (`sk_…`) en Supabase Vault, detrás de
--      dos funciones `security definer` que solo el service_role puede ejecutar.
--      Es el primer secreto por taller del sistema: no va en una columna (un
--      SELECT del dueño o un dump la expondrían) ni en el seed (repo público).
-- =============================================================================

-- ---------- 1. Activación por taller -----------------------------------------
alter table public.shops
  add column billing_enabled boolean not null default false;

-- ---------- 2. Datos fiscales del cliente -------------------------------------
alter table public.customers
  add column id_type   public.buyer_id_type,
  add column id_number text,
  add column address   text;

-- Tipo y número van juntos: un número sin tipo no se puede validar (cédula vs RUC
-- vs pasaporte) y un tipo sin número no prellena nada. Las filas existentes
-- tienen ambos NULL → el ALTER no puede fallar.
alter table public.customers
  add constraint customers_fiscal_id_pair_ck
  check ((id_type is null) = (id_number is null));

-- ---------- 3. Configuración fiscal del taller --------------------------------
create table public.shop_billing_settings (
  shop_id                uuid primary key references public.shops(id) on delete cascade,
  ruc                    text not null,
  razon_social           text not null,
  nombre_comercial       text,
  direccion_matriz       text not null,
  -- Serie del comprobante: 001-001-000000042 = establecimiento-punto-secuencial.
  -- El secuencial NO vive acá: lo asigna el proveedor (sequentialMode=platform).
  establecimiento        text not null default '001',
  punto_emision          text not null default '001',
  obligado_contabilidad  boolean not null default false,
  regimen                text not null default 'general',
  -- Nº de resolución de contribuyente especial (null = no lo es).
  contribuyente_especial text,
  environment            text not null default 'test',
  provider               text not null default 'autorizadorec',
  -- id de la empresa en el proveedor (AutorizadorEC lo devuelve numérico; se
  -- guarda como texto para no atar el esquema a un proveedor).
  provider_company_id    text,
  -- Vencimiento de la firma .p12. La firma y su clave NUNCA se guardan acá.
  cert_expires_at        timestamptz,
  -- Lo calcula billing-setup: empresa creada + API key en Vault + firma vigente.
  -- invoice-emit además re-chequea el vencimiento de la firma al emitir.
  ready                  boolean not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  constraint shop_billing_settings_ruc_format_ck
    check (ruc ~ '^[0-9]{13}$'),
  constraint shop_billing_settings_establecimiento_ck
    check (establecimiento ~ '^[0-9]{3}$' and establecimiento <> '000'),
  constraint shop_billing_settings_punto_emision_ck
    check (punto_emision ~ '^[0-9]{3}$' and punto_emision <> '000'),
  constraint shop_billing_settings_regimen_ck
    check (regimen in ('general', 'rimpe_emprendedor', 'rimpe_negocio_popular')),
  constraint shop_billing_settings_environment_ck
    check (environment in ('test', 'production')),
  constraint shop_billing_settings_razon_social_ck
    check (length(btrim(razon_social)) between 1 and 300),
  constraint shop_billing_settings_direccion_ck
    check (length(btrim(direccion_matriz)) between 1 and 300),
  -- UN taller por RUC en v1. No es una regla del SRI (una empresa con sucursales
  -- tiene un RUC y varios establecimientos) sino un candado de seguridad: la
  -- empresa del proveedor se resuelve por RUC y su API key firma comprobantes a
  -- nombre de ese RUC; si dos talleres pudieran declarar el mismo RUC, uno podría
  -- terminar emitiendo con la empresa (y la firma) del otro. Sucursales del mismo
  -- RUC en varios talleres = decisión aparte (dropear este unique + modelar el
  -- establecimiento por taller). Nombre explícito: billing-setup traduce el 23505.
  constraint shop_billing_settings_ruc_unique unique (ruc)
);

create trigger set_shop_billing_settings_updated_at
  before update on public.shop_billing_settings
  for each row execute function public.set_updated_at();

alter table public.shop_billing_settings enable row level security;

-- Solo SELECT (dueño de SU taller + admin cross-shop). Sin policies de
-- INSERT/UPDATE/DELETE: la escritura es exclusiva del service_role (billing-setup).
-- current_shop_id() es NULL para técnicos y admin → al técnico no le da nada.
create policy shop_billing_settings_select on public.shop_billing_settings
  for select to authenticated
  using ( shop_id = (select private.current_shop_id())
          or (select private.is_platform_admin()) );

-- ---------- 4. API key del proveedor por taller, en Vault ----------------------
-- Vault viene instalado en Supabase (hosted y local); el `if not exists` es solo
-- para que la migración no dependa de eso.
create extension if not exists supabase_vault with schema vault;

-- Nombre del secreto: 'billing_provider_key:<shop_id>'. Un solo secreto por taller;
-- volver a guardar (regenerar la key, re-crear la empresa) lo actualiza.
create or replace function public.set_billing_provider_key(p_shop_id uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text;
  v_id   uuid;
begin
  if p_shop_id is null or p_key is null or length(btrim(p_key)) = 0 then
    raise exception 'set_billing_provider_key: shop_id y clave son obligatorios'
      using errcode = '22023';
  end if;
  v_name := 'billing_provider_key:' || p_shop_id::text;

  select s.id into v_id from vault.secrets s where s.name = v_name;
  if v_id is null then
    perform vault.create_secret(
      p_key, v_name, 'API key del proveedor de facturación electrónica del taller');
  else
    perform vault.update_secret(v_id, p_key);
  end if;
end;
$$;

create or replace function public.get_billing_provider_key(p_shop_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select ds.decrypted_secret
    from vault.decrypted_secrets ds
   where ds.name = 'billing_provider_key:' || p_shop_id::text
   limit 1;
$$;

-- Solo el service_role (Edge Functions) las ejecuta. anon y authenticated se
-- revocan EXPLÍCITAMENTE: Supabase les concede EXECUTE sobre las funciones nuevas
-- de `public` por default privileges, así que un `revoke ... from public` NO
-- alcanza (verificado con has_function_privilege, ver 0037). Y son SECURITY
-- DEFINER: sin el revoke, cualquiera con la anon key podría LEER la API key de
-- cualquier taller (y emitir facturas a su nombre) o pisarla.
revoke execute on function public.set_billing_provider_key(uuid, text)
  from public, anon, authenticated;
grant  execute on function public.set_billing_provider_key(uuid, text)
  to service_role;

revoke execute on function public.get_billing_provider_key(uuid)
  from public, anon, authenticated;
grant  execute on function public.get_billing_provider_key(uuid)
  to service_role;

-- Al borrar la configuración (o el taller, por cascada) se borra también su
-- secreto: no dejar API keys huérfanas en Vault.
create or replace function private.billing_settings_drop_secret()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from vault.secrets
   where name = 'billing_provider_key:' || old.shop_id::text;
  return old;
end;
$$;

create trigger shop_billing_settings_drop_secret
  after delete on public.shop_billing_settings
  for each row execute function private.billing_settings_drop_secret();

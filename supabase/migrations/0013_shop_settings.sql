-- =============================================================================
-- 0013_shop_settings.sql
-- Configuración del taller editable por el dueño: name + logo_url + address.
-- Agrega las dos columnas nuevas y una RPC SECURITY DEFINER que permite al
-- shop_owner editar SOLO esas tres columnas de SU PROPIO taller.
--
-- Por qué una RPC y no una policy UPDATE: RLS no restringe por columna. Una policy
-- UPDATE abierta + trigger que rechace columnas protegidas (status, slug,
-- subscription_status, activated_at) funciona pero es un denylist que se pudre —
-- olvidar proteger una columna futura la vuelve editable en silencio. La RPC
-- invierte el default: nada es editable salvo el allowlist explícito de 3 columnas.
-- La policy admin-only `shops_update` (0002) queda intacta para todo lo demás.
--
-- El caller se deriva server-side vía private.current_shop_id() (reusa el helper
-- auditado). Un admin tiene shop_id NULL => el guard lo rechaza (los admins editan
-- por su propio camino). No hace falta chequear role='shop_owner' por separado: el
-- check constraint de profiles ata shop_owner <-> shop_id no nulo.
--
-- Semántica por columna (el FE debe conocerla):
--   - name: COALESCE (mandar NULL = no cambiar; name es NOT NULL, hay que protegerlo)
--   - logo_url / address: set directo (mandar NULL = limpiar el valor)
-- =============================================================================

-- ---------- Columnas nuevas (ambas nullable) ---------------------------------
alter table public.shops
  add column logo_url text,
  add column address  text;

-- ---------- RPC de auto-servicio para el dueño -------------------------------
create or replace function public.update_shop_settings(
  p_name     text,
  p_logo_url text,
  p_address  text
)
returns public.shops
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop_id uuid;
  v_row     public.shops;
begin
  v_shop_id := (select private.current_shop_id());
  if v_shop_id is null then
    raise exception 'update_shop_settings: el usuario no es dueño de un taller';
  end if;

  update public.shops
     set name     = coalesce(p_name, name),
         logo_url = p_logo_url,
         address  = p_address
   where id = v_shop_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.update_shop_settings(text, text, text) from public;
grant  execute on function public.update_shop_settings(text, text, text) to authenticated;

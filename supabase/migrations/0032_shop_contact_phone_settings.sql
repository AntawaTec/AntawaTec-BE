-- =============================================================================
-- 0032_shop_contact_phone_settings.sql
-- Suma `contact_phone` al allowlist de la RPC de configuración del taller.
--
-- La columna shops.contact_phone existe desde 0002 pero estaba HUÉRFANA: nadie la
-- lee ni la escribe. El dueño pasa a ser su primer escritor (no hay datos legacy
-- que respetar) porque el teléfono entra en la firma de los WhatsApp automáticos
-- que reciben sus clientes ("Taller Pablo · Tel. 0998765432"): el aviso de
-- "comunicarse con el administrador del taller" por fin dice CÓMO.
--
-- Por qué DROP + CREATE y no CREATE OR REPLACE: en Postgres la firma es parte de
-- la identidad de la función — un OR REPLACE con un parámetro más NO reemplaza,
-- CREA UN OVERLOAD. Quedarían conviviendo update_shop_settings(text,text,text) y
-- (text,text,text,text), y PostgREST no podría resolver la llamada por nombre de
-- argumento => PGRST203 (ambiguo) en cada guardado del FE. Borramos la vieja.
--
-- Por qué el 4º parámetro va SIN DEFAULT: con `default null` un FE viejo (que
-- manda 3 args) seguiría compilando contra la RPC y BORRARÍA el teléfono en
-- silencio en cada guardado — el peor modo de falla, silencioso y destructivo.
-- Sin default, ese FE viejo falla ruidoso (PGRST202, función no encontrada), que
-- es exactamente la señal que fuerza el deploy coordinado BE -> FE.
--
-- Por qué NO se replica el UNIQUE de contact_email: dos sucursales del mismo
-- dueño pueden compartir el teléfono de contacto. El email identifica una cuenta;
-- el teléfono es solo un dato de contacto que se imprime en un mensaje.
--
-- El resto es 0013 al pie de la letra (SECURITY DEFINER + search_path = '' +
-- private.current_shop_id() + revoke public / grant authenticated): la RPC existe
-- porque RLS no restringe por columna, y el allowlist explícito es lo que impide
-- que el dueño toque status / slug / subscription_status / activated_at.
--
-- Semántica por columna (el FE debe conocerla):
--   - name: COALESCE (mandar NULL = no cambiar; name es NOT NULL, hay que protegerlo)
--   - logo_url / address: set directo (mandar NULL = limpiar el valor)
--   - contact_phone: set directo con nullif(btrim(...), '') => la DB queda canónica
--     (teléfono o NULL, nunca ''), y el FE limpia mandando "" como ya hace hoy.
-- =============================================================================

drop function if exists public.update_shop_settings(text, text, text);

create function public.update_shop_settings(
  p_name          text,
  p_logo_url      text,
  p_address       text,
  p_contact_phone text
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
     set name          = coalesce(p_name, name),
         logo_url      = p_logo_url,
         address       = p_address,
         contact_phone = nullif(btrim(p_contact_phone), '')
   where id = v_shop_id
  returning * into v_row;

  return v_row;
end;
$$;

revoke execute on function public.update_shop_settings(text, text, text, text) from public;
grant  execute on function public.update_shop_settings(text, text, text, text) to authenticated;

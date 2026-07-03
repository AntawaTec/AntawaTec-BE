-- =============================================================================
-- 0014_shop_logos_storage.sql
-- Bucket `shop-logos` para el logo del taller. A diferencia de los buckets de
-- 0010 (privados + signed URLs), este es PÚBLICO de lectura: el logo aparece en la
-- cotización impresa y en el shell de la PWA, donde firmar cada render solo agrega
-- latencia para contenido que, por definición, es branding público.
--
-- En su PROPIA migración (separada de las columnas de 0013) para aislar el
-- blast-radius: las policies sobre storage.objects (tabla global compartida entre
-- buckets) pueden colisionar de nombre; si esto falla, los ALTER TABLE de shops de
-- 0013 ya quedaron aplicados. Mismo criterio por el que 0010 aísla storage.
--
-- LECTURA PÚBLICA POR DISEÑO: con public=true, los reads NO pasan por RLS — no hace
-- falta (ni sirve) una policy SELECT. Por eso el bucket SOLO debe contener contenido
-- INERTE: mime raster (png/jpeg/webp), SVG EXCLUIDO. Un SVG es documento activo
-- (<script>, onload=) y el admin de Antawa renderiza logos cross-tenant => un SVG
-- malicioso de un taller ejecutaría en sesión de antawa_admin, cruzando justo el
-- límite que CLAUDE.md trata como sagrado. Cap 2 MB (un logo no necesita más).
--
-- ESCRITURA aislada por taller: INSERT/UPDATE/DELETE solo si el primer folder del
-- path es el shop_id del caller. Convención de ruta: {shop_id}/logo.<ext>. Nota
-- consciente: el shop_id (un UUID) queda enumerable en la URL pública del logo;
-- aceptable para un logo no sensible, y el FE ya conoce su propio shop_id.
-- =============================================================================

-- ---------- Bucket público (raster-only, 2 MB) -------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('shop-logos', 'shop-logos', true, 2097152, array['image/png','image/jpeg','image/webp'])
on conflict (id) do nothing;

-- ---------- Policies de ESCRITURA por taller ({shop_id}/...) -----------------
-- (Sin policy SELECT: el bucket público sirve los reads sin pasar por RLS.)
create policy "shop-logos_tenant_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'shop-logos'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
  );

create policy "shop-logos_tenant_update" on storage.objects
  for update to authenticated
  using (
    bucket_id = 'shop-logos'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
  )
  with check (
    bucket_id = 'shop-logos'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
  );

create policy "shop-logos_tenant_delete" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'shop-logos'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
  );

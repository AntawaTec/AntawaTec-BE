-- =============================================================================
-- 0028_shop_logos_select_policy.sql
-- Fix: subir el logo del taller SIEMPRE fallaba con "new row violates row-level
-- security policy" (reportado por un dueño en prod; reproducido determinístico
-- en local).
--
-- Causa raíz: el FE sube con `upsert: true`, y storage-api lo traduce a
-- `INSERT ... ON CONFLICT DO UPDATE`. Postgres exige, para el brazo DO UPDATE,
-- que la fila objetivo sea visible por las políticas SELECT del rol — y falla
-- con la violación de RLS AUNQUE NO EXISTA fila en conflicto (verificado
-- empíricamente: el INSERT plano pasa, el INSERT..ON CONFLICT revienta con la
-- tabla vacía). `shop-logos` (0014) tiene políticas INSERT/UPDATE/DELETE pero
-- NINGUNA SELECT para authenticated: el bucket es público y las lecturas van
-- por URL pública, así que nadie la escribió. Los demás buckets no muerden
-- porque sus políticas son FOR ALL (incluyen SELECT) — por eso las fotos de
-- vehicle-media suben bien con el mismo helper.
--
-- Fix: política SELECT scoped al taller (misma expresión de tenancy que las
-- demás). No abre nada nuevo: el contenido ya es públicamente legible por URL
-- (bucket public=true); esto solo deja que el DUEÑO "vea" su fila vía SQL, que
-- es lo que el ON CONFLICT necesita. Verificado: con esta política el upsert
-- funciona (insert y update) y un path de otro taller sigue rechazado.
-- =============================================================================

create policy "shop-logos_tenant_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'shop-logos'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
  );

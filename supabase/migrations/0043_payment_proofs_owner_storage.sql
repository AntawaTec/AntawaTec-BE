-- =============================================================================
-- 0043_payment_proofs_owner_storage.sql
-- El dueño sube el comprobante de su renovación a `payment-proofs` bajo
-- `{shop_id}/renewals/…`, directo desde la PWA (sin Edge Function de intake:
-- acá SÍ hay un usuario autenticado y un taller, a diferencia del alta anónima).
--
-- En su PROPIA migración, separada de 0042, por el mismo criterio de 0010/0014:
-- `storage.objects` es una tabla GLOBAL compartida entre buckets y sus políticas
-- pueden colisionar de nombre; si esto falla, las columnas y policies de 0042 ya
-- quedaron aplicadas.
--
-- El bucket sigue siendo PRIVADO y `payment-proofs_admin_all` (0010) intacto:
-- el admin conserva acceso total. Esto solo abre una ventana angosta dentro del
-- bucket — la subcarpeta `renewals/` del PROPIO taller:
--   [1] = shop_id del caller  → aislamiento por taller (convención del repo)
--   [2] = 'renewals'          → los comprobantes de ALTA viven en `intake/{proofId}/`
--                               (ver bank-transfer-intake) y quedan fuera: un dueño
--                               NO puede leer el alta de otro prospecto.
--
-- Van INSERT y SELECT (no FOR ALL). El SELECT no es decorativo — lección de 0028:
--   (a) storage-api traduce `upsert: true` a INSERT ... ON CONFLICT DO UPDATE, y
--       Postgres exige que la fila sea visible por una política SELECT AUNQUE no
--       haya conflicto; sin SELECT, TODO upload falla con violación de RLS.
--   (b) el bucket es privado: sin SELECT el dueño no puede firmar (signed URL) su
--       propio comprobante para volver a verlo en la PWA.
-- Sin UPDATE ni DELETE: un comprobante subido es evidencia; no se pisa ni se
-- borra desde la app (mismo criterio que la ausencia de update/delete en la fila
-- de `bank_transfer_proofs`, 0042). Con `upsert: false` en el FE el INSERT basta;
-- el nombre del archivo lleva un uuid, así que no hay colisiones que resolver.
-- =============================================================================

create policy "payment-proofs_owner_renewal_insert" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
    and (storage.foldername(name))[2] = 'renewals'
  );

create policy "payment-proofs_owner_renewal_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'payment-proofs'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
    and (storage.foldername(name))[2] = 'renewals'
  );

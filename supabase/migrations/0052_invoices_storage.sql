-- =============================================================================
-- 0052_invoices_storage.sql
-- Bucket PRIVADO `invoices`: el XML autorizado y el RIDE (PDF) de cada factura,
-- en `{shop_id}/{invoice_id}/factura.xml` y `{shop_id}/{invoice_id}/ride.pdf`.
--
-- Guardar una copia propia del XML AUTORIZADO es parte del plan de salida del
-- proveedor (si AutorizadorEC desaparece, el comprobante válido ante el SRI es
-- ese XML, no el PDF).
--
-- Escritura SOLO service_role (invoice-emit / invoice-reconcile bajan los
-- archivos del proveedor y los suben acá): ni el dueño ni el admin pueden subir,
-- pisar o borrar un comprobante. Por eso NO se usa el generador
-- apply_tenant_storage_rls (que le da FOR ALL al dueño). El dueño LEE su carpeta
-- (signed URLs desde la PWA) y el admin lee cross-shop.
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'invoices',
  'invoices',
  false,
  10485760,  -- 10 MB
  array['application/xml', 'text/xml', 'application/pdf']
)
on conflict (id) do nothing;

create policy "invoices_owner_select" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'invoices'
    and (storage.foldername(name))[1] = (select private.current_shop_id())::text
  );

create policy "invoices_admin_select" on storage.objects
  for select to authenticated
  using ( bucket_id = 'invoices' and (select private.is_platform_admin()) );

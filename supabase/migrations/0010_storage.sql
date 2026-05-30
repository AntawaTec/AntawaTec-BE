-- =============================================================================
-- 0010_storage.sql
-- Storage buckets + tenant-isolated access policies on storage.objects.
-- PATH CONVENTION: every file is stored under "{shop_id}/...". Policies check
-- that the first folder of the path matches the caller's shop. This mirrors
-- the shop_id RLS pattern from 0002, applied to files.
-- Buckets are PRIVATE; files are served via signed URLs from the app.
-- =============================================================================

-- ---------- Buckets ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('vehicle-media',  'vehicle-media',  false, 52428800,  array['image/jpeg','image/png','image/webp','video/mp4','video/quicktime']),
  ('signatures',     'signatures',     false, 5242880,   array['image/png','image/jpeg','image/webp']),
  ('documents',      'documents',      false, 10485760,  array['image/jpeg','image/png','image/webp','application/pdf']),
  ('pdfs',           'pdfs',           false, 10485760,  array['application/pdf']),
  ('payment-proofs', 'payment-proofs', false, 10485760,  array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- ---------- Tenant storage policy generator ---------------------------------
-- For a given bucket:
--   - shop owners get full access to objects under their own "{shop_id}/" path
--   - platform admins get read access across the bucket
-- (storage.objects already has RLS enabled by Supabase.)
create or replace function private.apply_tenant_storage_rls(bucket text)
returns void
language plpgsql
as $fn$
begin
  execute format(
    'create policy %I on storage.objects for all to authenticated '
    'using (bucket_id = %L '
    '       and (storage.foldername(name))[1] = (select private.current_shop_id())::text) '
    'with check (bucket_id = %L '
    '       and (storage.foldername(name))[1] = (select private.current_shop_id())::text);',
    bucket || '_tenant_all', bucket, bucket);

  execute format(
    'create policy %I on storage.objects for select to authenticated '
    'using (bucket_id = %L and (select private.is_platform_admin()));',
    bucket || '_admin_read', bucket);
end;
$fn$;

revoke execute on function private.apply_tenant_storage_rls(text) from public;

-- ---------- Apply to tenant buckets -----------------------------------------
select private.apply_tenant_storage_rls('vehicle-media');
select private.apply_tenant_storage_rls('signatures');
select private.apply_tenant_storage_rls('documents');
select private.apply_tenant_storage_rls('pdfs');

-- ---------- payment-proofs: special case ------------------------------------
-- Prospects upload before a tenant exists, so uploads go through an Edge
-- Function (service role, bypasses RLS). Only platform admins read/manage here.
create policy "payment-proofs_admin_all" on storage.objects
  for all to authenticated
  using ( bucket_id = 'payment-proofs' and (select private.is_platform_admin()) )
  with check ( bucket_id = 'payment-proofs' and (select private.is_platform_admin()) );

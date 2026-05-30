-- =============================================================================
-- verify_schema.sql
-- READ-ONLY schema verification for AntawaTec.
-- Run in the Supabase SQL Editor and copy the single JSON cell back.
-- Returns one row, one column: a snapshot of tables, RLS, policies, helper
-- functions, the calculated-stock view, enums, and key constraints.
-- =============================================================================

select jsonb_pretty(jsonb_build_object(

  -- High-level counts. tables_without_rls MUST be 0.
  'summary', jsonb_build_object(
    'public_tables',
      (select count(*) from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'),
    'tables_without_rls',
      (select count(*) from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false),
    'total_policies',
      (select count(*) from pg_policies where schemaname = 'public'),
    'enum_types',
      (select count(distinct t.typname) from pg_type t
         join pg_enum e on e.enumtypid = t.oid
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'public'),
    'fk_to_shops',
      (select count(*) from pg_constraint con
         join pg_class rel  on rel.oid  = con.conrelid
         join pg_class frel on frel.oid = con.confrelid
         join pg_namespace n on n.oid = rel.relnamespace
        where n.nspname = 'public' and con.contype = 'f' and frel.relname = 'shops')
  ),

  -- The critical alarm: any public table here means a tenant-isolation hole.
  'tables_without_rls', (
    select coalesce(jsonb_agg(c.relname order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
  ),

  -- RLS flag for every public table.
  'rls_by_table', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', c.relname, 'rls', c.relrowsecurity) order by c.relname), '[]'::jsonb)
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
  ),

  -- Policy coverage per table (operational tables should show 4 cmds).
  'policies_by_table', (
    select coalesce(jsonb_agg(x order by x->>'table'), '[]'::jsonb)
    from (
      select jsonb_build_object(
               'table', tablename,
               'count', count(*),
               'cmds', jsonb_agg(cmd order by cmd)
             ) x
      from pg_policies
      where schemaname = 'public'
      group by tablename
    ) s
  ),

  -- RLS helper functions: must exist and be SECURITY DEFINER.
  'helper_functions', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'name', p.proname,
             'args', pg_get_function_identity_arguments(p.oid),
             'security_definer', p.prosecdef) order by p.proname), '[]'::jsonb)
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
  ),

  -- Calculated-stock view: reloptions must include security_invoker=true.
  'v_product_stock', (
    select jsonb_build_object(
             'exists', count(*) > 0,
             'reloptions', (select to_jsonb(c.reloptions)
                              from pg_class c join pg_namespace n on n.oid = c.relnamespace
                             where n.nspname = 'public' and c.relname = 'v_product_stock'))
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'v_product_stock' and c.relkind = 'v'
  ),

  -- Enum types and their ordered values.
  'enums', (
    select coalesce(jsonb_agg(jsonb_build_object('type', typname, 'values', vals)
                              order by typname), '[]'::jsonb)
    from (
      select t.typname, jsonb_agg(e.enumlabel order by e.enumsortorder) as vals
      from pg_type t
      join pg_enum e on e.enumtypid = t.oid
      join pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'public'
      group by t.typname
    ) z
  ),

  -- shop_id presence + nullability across tables.
  'shop_id_columns', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', table_name, 'nullable', is_nullable) order by table_name), '[]'::jsonb)
    from information_schema.columns
    where table_schema = 'public' and column_name = 'shop_id'
  ),

  -- CHECK constraints (expect profiles_role_shop_ck, quote_items_ref_ck).
  'check_constraints', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', rel.relname, 'name', con.conname,
             'def', pg_get_constraintdef(con.oid)) order by rel.relname, con.conname), '[]'::jsonb)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype = 'c'
  ),

  -- UNIQUE constraints (expect work_order_deliveries, webhook_events, shops.slug).
  'unique_constraints', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', rel.relname, 'name', con.conname,
             'def', pg_get_constraintdef(con.oid)) order by rel.relname, con.conname), '[]'::jsonb)
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and con.contype = 'u'
  ),

  -- updated_at triggers.
  'updated_at_triggers', (
    select coalesce(jsonb_agg(jsonb_build_object(
             'table', rel.relname, 'trigger', tg.tgname) order by rel.relname), '[]'::jsonb)
    from pg_trigger tg
    join pg_class rel on rel.oid = tg.tgrelid
    join pg_namespace n on n.oid = rel.relnamespace
    where n.nspname = 'public' and not tg.tgisinternal and tg.tgname like 'set\_%\_updated\_at'
  )

)) as schema_report;

-- =============================================================================
-- test_isolation.sql — Prove tenant isolation works under RLS.
-- Paste the same 3 UIDs from seed.sql. RUN EACH BLOCK SEPARATELY:
-- highlight one block and press Run (the editor only shows the last result).
-- Each block impersonates a user (set role authenticated + JWT claim) inside a
-- transaction, then rolls back so nothing changes.
--
-- NOTE: we read role/shop from public.profiles (the user's own row, allowed by
-- RLS) instead of calling private.* directly — the authenticated role can run
-- those helpers inside RLS policies, but not by name (schema private is hidden).
-- This mirrors how the real app reads the current user's profile.
-- =============================================================================


-- ====== BLOCK 1 — as OWNER A ======
-- EXPECT: shops_visible = 'Taller A', customers = 2, work_orders = 3,
--         my_role = 'shop_owner', my_shop_id = (Taller A's id)
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PASTE-OWNER-A-UID","role":"authenticated"}';
  select
    (select string_agg(name, ', ' order by name) from public.shops)     as shops_visible,
    (select count(*) from public.customers)                             as customers_visible,
    (select count(*) from public.work_orders)                           as work_orders_visible,
    (select shop_id from public.profiles where id = auth.uid())         as my_shop_id,
    (select role    from public.profiles where id = auth.uid())         as my_role;
rollback;


-- ====== BLOCK 2 — as OWNER B ======
-- EXPECT: shops_visible = 'Taller B', customers = 1, work_orders = 1,
--         my_role = 'shop_owner'. Owner B must NEVER see Taller A data.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PASTE-OWNER-B-UID","role":"authenticated"}';
  select
    (select string_agg(name, ', ' order by name) from public.shops)     as shops_visible,
    (select count(*) from public.customers)                             as customers_visible,
    (select count(*) from public.work_orders)                           as work_orders_visible,
    (select shop_id from public.profiles where id = auth.uid())         as my_shop_id,
    (select role    from public.profiles where id = auth.uid())         as my_role;
rollback;


-- ====== BLOCK 3 — as ANTAWA ADMIN ======
-- EXPECT: shops_visible = 'Taller A, Taller B', customers = 3,
--         work_orders = 4, my_shop_id = NULL, my_role = 'antawa_admin'.
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PASTE-ADMIN-UID","role":"authenticated"}';
  select
    (select string_agg(name, ', ' order by name) from public.shops)     as shops_visible,
    (select count(*) from public.customers)                             as customers_visible,
    (select count(*) from public.work_orders)                           as work_orders_visible,
    (select shop_id from public.profiles where id = auth.uid())         as my_shop_id,
    (select role    from public.profiles where id = auth.uid())         as my_role;
rollback;


-- ====== BLOCK 4 — calculated stock, as OWNER A ======
-- EXPECT: only Taller A products. Filtro de aceite = 8 (ok),
--         Bujía = 5 with below_threshold = true. (View must respect RLS.)
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"PASTE-OWNER-A-UID","role":"authenticated"}';
  select product_name, current_stock, threshold, below_threshold
  from public.v_product_stock
  order by product_name;
rollback;

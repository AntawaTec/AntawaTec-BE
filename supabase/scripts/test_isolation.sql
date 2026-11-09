-- =============================================================================
-- test_isolation.sql — Prove tenant isolation works under RLS.
-- UIDs FIJOS del seed determinista (supabase/seed.sql) — ya no hay que pegar nada.
-- RUN EACH BLOCK SEPARATELY:
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
  set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000001","role":"authenticated"}';
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
  set local request.jwt.claims = '{"sub":"b0000000-0000-4000-a000-000000000001","role":"authenticated"}';
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
  set local request.jwt.claims = '{"sub":"ad000000-0000-4000-a000-000000000001","role":"authenticated"}';
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
  set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000001","role":"authenticated"}';
  select product_name, current_stock, threshold, below_threshold
  from public.v_product_stock
  order by product_name;
rollback;


-- =============================================================================
-- FACTURACIÓN SRI (0050–0052). Bloques AUTO-VERIFICABLES: cada uno siembra sus
-- fixtures como postgres dentro de la transacción, cambia de rol y corre un DO
-- que lanza EXCEPTION ante el primer fallo (si termina, imprime NOTICE 'OK …').
-- Todo es rollback: no deja nada. RUC/cédulas ficticios (patrones, no reales).
-- Por psql:  psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/scripts/test_isolation.sql
-- =============================================================================

-- ====== BLOCK 5 — facturas: taller B, técnico y admin ======
-- EXPECT: NOTICE 'OK block 5'. B no ve facturas, ítems, settings ni archivos de A;
--         el técnico de A no ve nada; el admin ve todo.
begin;
  insert into public.shop_billing_settings (shop_id, ruc, razon_social, direccion_matriz)
    values ('a1000000-0000-4000-a000-000000000001', '1799999990001', 'Taller A Ficticio S.A.', 'Calle Falsa 123');
  insert into public.invoices (id, shop_id, buyer_id_type, buyer_id_number, buyer_name, subtotal, tax_total, total)
    values ('f0000000-0000-4000-a000-000000000001', 'a1000000-0000-4000-a000-000000000001',
            'cedula', '1711111110', 'Cliente Ficticio', 10, 1.5, 11.5);
  insert into public.invoice_items (shop_id, invoice_id, description, quantity, unit_price, line_subtotal, line_tax)
    values ('a1000000-0000-4000-a000-000000000001', 'f0000000-0000-4000-a000-000000000001', 'Servicio', 1, 10, 10, 1.5);
  insert into storage.objects (bucket_id, name)
    values ('invoices', 'a1000000-0000-4000-a000-000000000001/f0000000-0000-4000-a000-000000000001/ride.pdf');

  -- Owner B
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"b0000000-0000-4000-a000-000000000001","role":"authenticated"}';
  do $$
  begin
    if (select count(*) from public.invoices) <> 0 then raise exception 'B ve facturas de A'; end if;
    if (select count(*) from public.invoice_items) <> 0 then raise exception 'B ve ítems de A'; end if;
    if (select count(*) from public.shop_billing_settings) <> 0 then raise exception 'B ve settings de A'; end if;
    if (select count(*) from storage.objects where bucket_id = 'invoices') <> 0 then raise exception 'B ve archivos de A'; end if;
    -- B no puede colgar una factura en el taller de A
    begin
      insert into public.invoices (shop_id, buyer_id_type, buyer_id_number, buyer_name)
        values ('a1000000-0000-4000-a000-000000000001', 'cedula', '1711111110', 'x');
      raise exception 'B insertó una factura en el taller A';
    exception when insufficient_privilege then null;
    end;
    -- ni un ítem en una factura de A
    begin
      insert into public.invoice_items (shop_id, invoice_id, description, quantity, unit_price, line_subtotal, line_tax)
        values ('b1000000-0000-4000-a000-000000000001', 'f0000000-0000-4000-a000-000000000001', 'x', 1, 1, 1, 0);
      raise exception 'B insertó un ítem en una factura de A';
    exception when foreign_key_violation or insufficient_privilege then null;
    end;
    raise notice 'OK block 5 (owner B)';
  end $$;

  -- Técnico de A (login)
  set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-0000000000c1","role":"authenticated"}';
  do $$
  begin
    if (select count(*) from public.invoices) <> 0 then raise exception 'el técnico ve facturas'; end if;
    if (select count(*) from public.invoice_items) <> 0 then raise exception 'el técnico ve ítems'; end if;
    if (select count(*) from public.shop_billing_settings) <> 0 then raise exception 'el técnico ve settings'; end if;
    if (select count(*) from storage.objects where bucket_id = 'invoices') <> 0 then raise exception 'el técnico ve archivos'; end if;
    raise notice 'OK block 5 (técnico)';
  end $$;

  -- Admin
  set local request.jwt.claims = '{"sub":"ad000000-0000-4000-a000-000000000001","role":"authenticated"}';
  do $$
  begin
    if (select count(*) from public.invoices) <> 1 then raise exception 'el admin no ve la factura'; end if;
    if (select count(*) from public.invoice_items) <> 1 then raise exception 'el admin no ve el ítem'; end if;
    if (select count(*) from public.shop_billing_settings) <> 1 then raise exception 'el admin no ve settings'; end if;
    if (select count(*) from storage.objects where bucket_id = 'invoices') <> 1 then raise exception 'el admin no ve el archivo'; end if;
    raise notice 'OK block 5 (admin)';
  end $$;
rollback;


-- ====== BLOCK 6 — facturas: lo que el DUEÑO puede y no puede hacer ======
-- EXPECT: NOTICE 'OK block 6'.
begin;
  insert into public.invoices (id, shop_id, buyer_id_type, buyer_id_number, buyer_name, subtotal, tax_total, total)
    values ('f0000000-0000-4000-a000-000000000002', 'a1000000-0000-4000-a000-000000000001',
            'cedula', '1711111110', 'Cliente Ficticio', 10, 1.5, 11.5);
  insert into public.invoice_items (id, shop_id, invoice_id, description, quantity, unit_price, line_subtotal, line_tax)
    values ('f1000000-0000-4000-a000-000000000002', 'a1000000-0000-4000-a000-000000000001',
            'f0000000-0000-4000-a000-000000000002', 'Servicio', 1, 10, 10, 1.5);
  -- La pasa a autorizada el service_role (aquí: postgres), como haría invoice-emit.
  update public.invoices
     set status = 'authorized', establecimiento = '001', punto_emision = '001', secuencial = '000000001',
         access_key = repeat('1', 49), authorization_number = repeat('1', 49), authorized_at = now()
   where id = 'f0000000-0000-4000-a000-000000000002';

  set local role authenticated;
  set local request.jwt.claims = '{"sub":"a0000000-0000-4000-a000-000000000001","role":"authenticated"}';
  do $$
  declare
    n int;
    v_draft uuid;
  begin
    -- (a) La autorizada es visible pero intocable.
    if (select count(*) from public.invoices where id = 'f0000000-0000-4000-a000-000000000002') <> 1 then
      raise exception 'A no ve su factura autorizada';
    end if;
    update public.invoices set buyer_name = 'hack' where id = 'f0000000-0000-4000-a000-000000000002';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'A editó una factura autorizada'; end if;
    update public.invoices set status = 'draft' where id = 'f0000000-0000-4000-a000-000000000002';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'A devolvió una autorizada a borrador'; end if;
    delete from public.invoices where id = 'f0000000-0000-4000-a000-000000000002';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'A borró una factura autorizada'; end if;

    -- (b) Sus ítems tampoco (el trigger los bloquea aunque la RLS de ítems deje pasar).
    begin
      update public.invoice_items set unit_price = 1 where id = 'f1000000-0000-4000-a000-000000000002';
      raise exception 'A editó un ítem de una factura autorizada';
    exception when insufficient_privilege then null;
    end;
    begin
      delete from public.invoice_items where id = 'f1000000-0000-4000-a000-000000000002';
      raise exception 'A borró un ítem de una factura autorizada';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.invoice_items (shop_id, invoice_id, description, quantity, unit_price, line_subtotal, line_tax)
        values ('a1000000-0000-4000-a000-000000000001', 'f0000000-0000-4000-a000-000000000002', 'extra', 1, 1, 1, 0.15);
      raise exception 'A agregó un ítem a una factura autorizada';
    exception when insufficient_privilege then null;
    end;

    -- (c) No puede fabricar una factura no-borrador ni con campos del servidor.
    begin
      insert into public.invoices (shop_id, status, buyer_id_type, buyer_id_number, buyer_name)
        values ('a1000000-0000-4000-a000-000000000001', 'authorized', 'cedula', '1711111110', 'x');
      raise exception 'A insertó una factura authorized';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.invoices (shop_id, buyer_id_type, buyer_id_number, buyer_name, access_key)
        values ('a1000000-0000-4000-a000-000000000001', 'cedula', '1711111110', 'x', repeat('2', 49));
      raise exception 'A insertó un borrador con clave de acceso';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into public.invoices (shop_id, buyer_id_type, buyer_id_number, buyer_name, secuencial)
        values ('a1000000-0000-4000-a000-000000000001', 'cedula', '1711111110', 'x', '000000009');
      raise exception 'A insertó un borrador con secuencial';
    exception when insufficient_privilege then null;
    end;

    -- (d) Un borrador propio: editable, pero no lo puede sacar de draft ni llenarle
    --     campos del servidor; FKs cross-taller rechazadas.
    insert into public.invoices (shop_id, buyer_id_type, buyer_id_number, buyer_name)
      values ('a1000000-0000-4000-a000-000000000001', 'cedula', '1711111110', 'Borrador')
      returning id into v_draft;
    insert into public.invoice_items (shop_id, invoice_id, description, quantity, unit_price, line_subtotal, line_tax)
      values ('a1000000-0000-4000-a000-000000000001', v_draft, 'Línea 1', 1, 10, 10, 1.5),
             ('a1000000-0000-4000-a000-000000000001', v_draft, 'Línea 2', 2, 5, 10, 1.5);
    update public.invoices set buyer_name = 'Borrador editado' where id = v_draft;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'A no pudo editar su borrador'; end if;
    update public.invoice_items set unit_price = 11 where invoice_id = v_draft and description = 'Línea 1';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'A no pudo editar un ítem de su borrador'; end if;
    begin
      update public.invoices set status = 'processing' where id = v_draft;
      raise exception 'A pasó su borrador a processing';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.invoices set status = 'authorized' where id = v_draft;
      raise exception 'A autorizó su borrador';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.invoices set authorization_number = '123' where id = v_draft;
      raise exception 'A llenó authorization_number';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.invoices set xml_path = 'x' where id = v_draft;
      raise exception 'A llenó xml_path';
    exception when insufficient_privilege then null;
    end;
    begin
      update public.invoices set work_order_id = 'bc000000-0000-4000-a000-000000000001' where id = v_draft;
      raise exception 'A enlazó una orden del taller B';
    exception when foreign_key_violation then null;
    end;
    begin
      update public.invoices set customer_id = 'b3000000-0000-4000-a000-000000000001' where id = v_draft;
      raise exception 'A enlazó un cliente del taller B';
    exception when foreign_key_violation then null;
    end;

    -- (e) Borrar el borrador borra sus ítems (cascada que el trigger deja pasar).
    delete from public.invoices where id = v_draft;
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'A no pudo borrar su borrador'; end if;
    if (select count(*) from public.invoice_items where invoice_id = v_draft) <> 0 then
      raise exception 'quedaron ítems del borrador borrado';
    end if;

    -- (f) Settings: solo lectura; RPCs de servidor y archivos: vedados.
    begin
      insert into public.shop_billing_settings (shop_id, ruc, razon_social, direccion_matriz)
        values ('a1000000-0000-4000-a000-000000000001', '1799999990001', 'x', 'y');
      raise exception 'A escribió shop_billing_settings';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.acquire_invoice_for_emission('f0000000-0000-4000-a000-000000000002');
      raise exception 'A ejecutó acquire_invoice_for_emission';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.get_billing_provider_key('a1000000-0000-4000-a000-000000000001');
      raise exception 'A leyó la API key del proveedor';
    exception when insufficient_privilege then null;
    end;
    begin
      insert into storage.objects (bucket_id, name)
        values ('invoices', 'a1000000-0000-4000-a000-000000000001/f0000000-0000-4000-a000-000000000002/ride.pdf');
      raise exception 'A subió un archivo al bucket invoices';
    exception when insufficient_privilege then null;
    end;
    -- El dueño tampoco puede prender la facturación de su taller (shops_update es admin-only).
    update public.shops set billing_enabled = true where id = 'a1000000-0000-4000-a000-000000000001';
    get diagnostics n = row_count;
    if n <> 0 then raise exception 'A activó billing_enabled'; end if;

    raise notice 'OK block 6 (owner A)';
  end $$;
rollback;


-- ====== BLOCK 7 — lock de emisión y privilegios de las funciones ======
-- EXPECT: NOTICE 'OK block 7'. Solo service_role ejecuta las RPC de facturación;
--         el lock pasa draft → processing una sola vez.
begin;
  do $$
  declare
    r record;
    n int;
  begin
    if has_function_privilege('anon', 'public.acquire_invoice_for_emission(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.acquire_invoice_for_emission(uuid)', 'execute')
       or has_function_privilege('anon', 'public.get_billing_provider_key(uuid)', 'execute')
       or has_function_privilege('authenticated', 'public.get_billing_provider_key(uuid)', 'execute')
       or has_function_privilege('anon', 'public.set_billing_provider_key(uuid, text)', 'execute')
       or has_function_privilege('authenticated', 'public.set_billing_provider_key(uuid, text)', 'execute') then
      raise exception 'anon/authenticated tienen EXECUTE sobre una RPC de facturación';
    end if;
    if not has_function_privilege('service_role', 'public.acquire_invoice_for_emission(uuid)', 'execute') then
      raise exception 'service_role sin EXECUTE sobre acquire_invoice_for_emission';
    end if;

    insert into public.invoices (id, shop_id, buyer_id_type, buyer_id_number, buyer_name)
      values ('f0000000-0000-4000-a000-000000000003', 'a1000000-0000-4000-a000-000000000001', 'cedula', '1711111110', 'x');
    select * into r from public.acquire_invoice_for_emission('f0000000-0000-4000-a000-000000000003');
    if r.previous_status is distinct from 'draft' then raise exception 'el lock no devolvió draft'; end if;
    select count(*) into n from public.acquire_invoice_for_emission('f0000000-0000-4000-a000-000000000003');
    if n <> 0 then raise exception 'el lock se tomó dos veces'; end if;
    update public.invoices set status = 'failed' where id = 'f0000000-0000-4000-a000-000000000003';
    select * into r from public.acquire_invoice_for_emission('f0000000-0000-4000-a000-000000000003');
    if r.previous_status is distinct from 'failed' then raise exception 'el lock no re-tomó una failed'; end if;

    -- Vault: guardar dos veces actualiza (un solo secreto por taller) y borrar los
    -- settings borra el secreto.
    perform public.set_billing_provider_key('a1000000-0000-4000-a000-000000000001', 'sk_ficticia_1');
    perform public.set_billing_provider_key('a1000000-0000-4000-a000-000000000001', 'sk_ficticia_2');
    if public.get_billing_provider_key('a1000000-0000-4000-a000-000000000001') <> 'sk_ficticia_2' then
      raise exception 'Vault no devolvió la última key';
    end if;
    insert into public.shop_billing_settings (shop_id, ruc, razon_social, direccion_matriz)
      values ('a1000000-0000-4000-a000-000000000001', '1799999990001', 'x', 'y');
    delete from public.shop_billing_settings where shop_id = 'a1000000-0000-4000-a000-000000000001';
    if public.get_billing_provider_key('a1000000-0000-4000-a000-000000000001') is not null then
      raise exception 'quedó una API key huérfana en Vault';
    end if;

    -- Consumidor final: > USD 50 rechazado por la DB.
    begin
      insert into public.invoices (shop_id, buyer_id_type, buyer_id_number, buyer_name, total)
        values ('a1000000-0000-4000-a000-000000000001', 'consumidor_final', '9999999999999', 'CONSUMIDOR FINAL', 50.01);
      raise exception 'consumidor final > 50 aceptado';
    exception when check_violation then null;
    end;
    raise notice 'OK block 7';
  end $$;
rollback;

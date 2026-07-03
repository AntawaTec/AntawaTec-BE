-- =============================================================================
-- seed.sql — Seed DETERMINISTA de AntawaTec (2 talleres) para demo + tests.
--
-- Lo corre automáticamente `supabase db reset` (config.toml → [db.seed]
-- sql_paths = ["./seed.sql"]). NO requiere pegar UIDs a mano: crea los usuarios
-- de auth (con password) y todo lo demás con UUIDs FIJOS, en orden, en un solo
-- archivo. Idempotente: delete-then-insert para auth, `on conflict do nothing`
-- para datos → re-correrlo (vía db reset o `psql -f`) converge sin duplicar.
--
-- Durante `db reset` corre como superusuario (postgres) → puede escribir en
-- auth.* y saltar RLS, igual que el provisioning con service_role.
--
-- Por qué insert directo a auth.users + auth.identities (y no la Admin API):
-- este repo NO tiene runtime JS/TS local (las Edge Functions corren dentro del
-- runtime de Supabase, no hay binario `deno`/`node` ni package.json). El insert
-- SQL directo es el único camino "una sola orden = supabase db reset" sin sumar
-- un toolchain nuevo. VERIFICADO empíricamente: signInWithPassword funciona
-- contra estas filas. Acopla al esquema interno de GoTrue, pero es LOCAL-ONLY
-- (jamás toca remoto) y el patrón es estable.
--
-- CREDENCIALES DE TEST (local-only, commiteadas a propósito — nunca tocan prod):
--   admin@antawa.test  / admin-pass-123   (antawa_admin, sin shop)
--   ownera@antawa.test / ownera-pass-123  (shop_owner, Taller A)
--   ownerb@antawa.test / ownerb-pass-123  (shop_owner, Taller B)
--
-- El FE NUNCA hardcodea estos UUIDs (constitución: no espejar el esquema/IDs del
-- BE). La rebanada real-JWT descubre shop_id vía `profiles` y las filas por sus
-- atributos de negocio. Los UUIDs fijos son una conveniencia interna del BE.
-- =============================================================================

do $$
declare
  -- ===== Usuarios de auth =====
  admin_uid   uuid := 'ad000000-0000-4000-a000-000000000001';
  owner_a     uuid := 'a0000000-0000-4000-a000-000000000001';
  owner_b     uuid := 'b0000000-0000-4000-a000-000000000001';
  tech_a1_uid uuid := 'a0000000-0000-4000-a000-0000000000c1'; -- login del técnico (→ technicians.profile_id de tech_a1)

  -- ===== Tenants =====
  shop_a uuid := 'a1000000-0000-4000-a000-000000000001';
  shop_b uuid := 'b1000000-0000-4000-a000-000000000001';

  -- ===== Técnicos =====
  tech_a1 uuid := 'a2000000-0000-4000-a000-000000000001';
  tech_a2 uuid := 'a2000000-0000-4000-a000-000000000002';
  tech_b1 uuid := 'b2000000-0000-4000-a000-000000000001';

  -- ===== Clientes =====
  cust_a1 uuid := 'a3000000-0000-4000-a000-000000000001';
  cust_a2 uuid := 'a3000000-0000-4000-a000-000000000002';
  cust_b1 uuid := 'b3000000-0000-4000-a000-000000000001';

  -- ===== Vehículos =====
  veh_a1 uuid := 'a4000000-0000-4000-a000-000000000001';
  veh_a2 uuid := 'a4000000-0000-4000-a000-000000000002';
  veh_b1 uuid := 'b4000000-0000-4000-a000-000000000001';

  -- ===== Catálogo de inventario =====
  sup_a   uuid := 'a5000000-0000-4000-a000-000000000001';
  prod_a1 uuid := 'a6000000-0000-4000-a000-000000000001';
  prod_a2 uuid := 'a6000000-0000-4000-a000-000000000002';
  prod_b1 uuid := 'b6000000-0000-4000-a000-000000000001';
  svc_a1  uuid := 'a7000000-0000-4000-a000-000000000001';

  -- ===== Cotizaciones =====
  quote_a1 uuid := 'a8000000-0000-4000-a000-000000000001';
  quote_b1 uuid := 'b8000000-0000-4000-a000-000000000001';
  qsec_a1  uuid := 'a9000000-0000-4000-a000-000000000001';
  qsec_b1  uuid := 'b9000000-0000-4000-a000-000000000001';
  qitem_a1 uuid := 'aa000000-0000-4000-a000-000000000001';
  qitem_a2 uuid := 'aa000000-0000-4000-a000-000000000002';
  qitem_a3 uuid := 'aa000000-0000-4000-a000-000000000003';
  qitem_b1 uuid := 'ba000000-0000-4000-a000-000000000001';

  -- ===== Citas =====
  appt_a1 uuid := 'ab000000-0000-4000-a000-000000000001';

  -- ===== Órdenes de trabajo =====
  wo_a1 uuid := 'ac000000-0000-4000-a000-000000000001';  -- reception
  wo_a2 uuid := 'ac000000-0000-4000-a000-000000000002';  -- in_process
  wo_a3 uuid := 'ac000000-0000-4000-a000-000000000003';  -- delivery (deliverable, sin entrega aún)
  wo_b1 uuid := 'bc000000-0000-4000-a000-000000000001';

  -- ===== Movimientos de inventario =====
  mov_a1 uuid := 'ae000000-0000-4000-a000-000000000001';
  mov_a2 uuid := 'ae000000-0000-4000-a000-000000000002';
  mov_a3 uuid := 'ae000000-0000-4000-a000-000000000003';
  mov_a4 uuid := 'ae000000-0000-4000-a000-000000000004';

  inst uuid := '00000000-0000-0000-0000-000000000000';
begin
  -- ---------- 1. Usuarios de auth (con password) + identities ----------
  -- delete-then-insert = idempotente. Durante db reset la tabla está vacía
  -- (el reset recrea el contenedor) → el delete es no-op; en un re-run via psql
  -- limpia las filas previas antes de reinsertar.
  delete from auth.identities where user_id in (admin_uid, owner_a, owner_b, tech_a1_uid);
  delete from auth.users      where id      in (admin_uid, owner_a, owner_b, tech_a1_uid);

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  ) values
    (inst, admin_uid, 'authenticated', 'authenticated', 'admin@antawa.test',
       crypt('admin-pass-123', gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Admin Antawa"}'::jsonb, '', '', '', ''),
    (inst, owner_a, 'authenticated', 'authenticated', 'ownera@antawa.test',
       crypt('ownera-pass-123', gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Dueño Taller A"}'::jsonb, '', '', '', ''),
    (inst, owner_b, 'authenticated', 'authenticated', 'ownerb@antawa.test',
       crypt('ownerb-pass-123', gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Dueño Taller B"}'::jsonb, '', '', '', ''),
    (inst, tech_a1_uid, 'authenticated', 'authenticated', 'techa@antawa.test',
       crypt('techa-pass-123', gen_salt('bf')), now(), now(), now(),
       '{"provider":"email","providers":["email"]}'::jsonb,
       '{"full_name":"Juan Pérez (técnico)"}'::jsonb, '', '', '', '');

  insert into auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) values
    (gen_random_uuid(), admin_uid, admin_uid::text,
       jsonb_build_object('sub', admin_uid::text, 'email', 'admin@antawa.test', 'email_verified', true),
       'email', now(), now(), now()),
    (gen_random_uuid(), owner_a, owner_a::text,
       jsonb_build_object('sub', owner_a::text, 'email', 'ownera@antawa.test', 'email_verified', true),
       'email', now(), now(), now()),
    (gen_random_uuid(), owner_b, owner_b::text,
       jsonb_build_object('sub', owner_b::text, 'email', 'ownerb@antawa.test', 'email_verified', true),
       'email', now(), now(), now()),
    (gen_random_uuid(), tech_a1_uid, tech_a1_uid::text,
       jsonb_build_object('sub', tech_a1_uid::text, 'email', 'techa@antawa.test', 'email_verified', true),
       'email', now(), now(), now());

  -- ---------- 2. Tenants ----------
  insert into public.shops (id, name, slug, status, contact_email, activated_at) values
    (shop_a, 'Taller A', 'taller-a', 'active', 'ownera@antawa.test', now()),
    (shop_b, 'Taller B', 'taller-b', 'active', 'ownerb@antawa.test', now())
  on conflict do nothing;

  -- ---------- 3. Profiles (enlazan usuarios ↔ rol/shop) ----------
  insert into public.profiles (id, shop_id, role, full_name) values
    (admin_uid,   null,   'antawa_admin', 'Admin Antawa'),
    (owner_a,     shop_a, 'shop_owner',   'Dueño Taller A'),
    (owner_b,     shop_b, 'shop_owner',   'Dueño Taller B'),
    (tech_a1_uid, shop_a, 'technician',   'Juan Pérez (técnico)')
  on conflict do nothing;

  -- ---------- 4. Técnicos ----------
  insert into public.technicians (id, shop_id, full_name) values
    (tech_a1, shop_a, 'Juan Pérez'),
    (tech_a2, shop_a, 'Pedro Gómez'),
    (tech_b1, shop_b, 'Carlos Ruiz')
  on conflict do nothing;

  -- Enlace login↔técnico: tech_a1 inicia sesión (asignado a wo_a1 + wo_a3). tech_a2
  -- queda como staff sin login (el default de V1) → así la rebanada prueba "técnico
  -- con login ve solo SUS órdenes, no las de otro técnico del mismo taller".
  update public.technicians set profile_id = tech_a1_uid where id = tech_a1;

  -- ---------- 5. Clientes ----------
  insert into public.customers (id, shop_id, name, is_fleet, fleet_name, whatsapp_number) values
    (cust_a1, shop_a, 'Transportes Andinos', true,  'Flota Andinos', '+593990000001'),
    (cust_a2, shop_a, 'María López',          false, null,            '+593990000002'),
    (cust_b1, shop_b, 'José Torres',          false, null,            '+593990000003')
  on conflict do nothing;

  -- ---------- 6. Vehículos ----------
  insert into public.vehicles (id, shop_id, customer_id, make, model, year, plate, fuel_type, mileage) values
    (veh_a1, shop_a, cust_a1, 'Chevrolet', 'NPR',   2019, 'PBA-1234', 'diesel',   120000),
    (veh_a2, shop_a, cust_a2, 'Kia',       'Rio',   2021, 'PCD-5678', 'gasoline', 45000),
    (veh_b1, shop_b, cust_b1, 'Toyota',    'Hilux', 2020, 'PXY-9999', 'diesel',   80000)
  on conflict do nothing;

  -- ---------- 7. Catálogo de inventario ----------
  insert into public.suppliers (id, shop_id, name, phone) values
    (sup_a, shop_a, 'Repuestos Quito', '+59322000000')
  on conflict do nothing;

  insert into public.products (id, shop_id, supplier_id, brand, model, name, uom, cost, suggested_price, threshold) values
    (prod_a1, shop_a, sup_a, 'Bosch', 'F026', 'Filtro de aceite', 'unit', 4.50, 9.00,  5),
    (prod_a2, shop_a, sup_a, 'NGK',   'BKR6', 'Bujía',            'unit', 2.00, 5.00,  10),
    (prod_b1, shop_b, null,  'Mann',  'C25',  'Filtro de aire',   'unit', 6.00, 12.00, 4)
  on conflict do nothing;

  insert into public.services (id, shop_id, name, price) values
    (svc_a1, shop_a, 'Cambio de aceite', 15.00)
  on conflict do nothing;

  -- ---------- 8. Cotización aprobada (Taller A) ----------
  insert into public.quotes (id, shop_id, customer_id, vehicle_id, status, subtotal, tax, total, approved_at, created_by) values
    (quote_a1, shop_a, cust_a2, veh_a2, 'approved', 39.00, 5.85, 44.85, now(), owner_a)
  on conflict do nothing;

  insert into public.quote_sections (id, shop_id, quote_id, section_type, subtotal) values
    (qsec_a1, shop_a, quote_a1, 'maintenance', 39.00)
  on conflict do nothing;

  insert into public.quote_items (id, shop_id, quote_section_id, item_type, product_id, service_id, description, quantity, unit_price, line_total) values
    (qitem_a1, shop_a, qsec_a1, 'part',  prod_a1, null,    'Filtro de aceite', 1, 9.00,  9.00),
    (qitem_a2, shop_a, qsec_a1, 'part',  prod_a2, null,    'Bujía',            3, 5.00,  15.00),
    (qitem_a3, shop_a, qsec_a1, 'labor', null,    svc_a1,  'Cambio de aceite', 1, 15.00, 15.00)
  on conflict do nothing;

  -- ---------- 8b. Cotización aprobada (Taller B) — para el target FK compuesto ----------
  -- Existe para que la rebanada pruebe: A autenticado NO puede enlazar la
  -- cotización de B a su orden (getLinkedQuoteForOrder null + setWorkOrderQuote
  -- rechazado por el FK compuesto (quote_id, shop_id)).
  insert into public.quotes (id, shop_id, customer_id, vehicle_id, status, subtotal, tax, total, approved_at, created_by) values
    (quote_b1, shop_b, cust_b1, veh_b1, 'approved', 12.00, 1.80, 13.80, now(), owner_b)
  on conflict do nothing;

  insert into public.quote_sections (id, shop_id, quote_id, section_type, subtotal) values
    (qsec_b1, shop_b, quote_b1, 'maintenance', 12.00)
  on conflict do nothing;

  insert into public.quote_items (id, shop_id, quote_section_id, item_type, product_id, service_id, description, quantity, unit_price, line_total) values
    (qitem_b1, shop_b, qsec_b1, 'part', prod_b1, null, 'Filtro de aire', 1, 12.00, 12.00)
  on conflict do nothing;

  -- ---------- 9. Cita (desde la cotización aprobada de A) ----------
  insert into public.appointments (id, shop_id, customer_id, vehicle_id, quote_id, scheduled_at, status, source) values
    (appt_a1, shop_a, cust_a2, veh_a2, quote_a1, now() + interval '1 day', 'confirmed', 'quote')
  on conflict do nothing;

  -- ---------- 10. Órdenes de trabajo por estado del Kanban (Taller A) ----------
  insert into public.work_orders (id, shop_id, customer_id, vehicle_id, appointment_id, technician_id, mileage_in, fuel_level, checklist, estimated_total, status, created_by) values
    (wo_a1, shop_a, cust_a1, veh_a1, null,    tech_a1, 120500, '1/2',  '{"jack":true,"tools":true,"kit":false}'::jsonb, 80.00,  'reception',  owner_a),
    (wo_a2, shop_a, cust_a2, veh_a2, appt_a1, tech_a2, 45200,  '3/4',  '{"jack":true,"tools":true,"kit":true}'::jsonb,  44.85,  'in_process', owner_a),
    (wo_a3, shop_a, cust_a1, veh_a1, null,    tech_a1, 119000, 'full', '{"jack":true,"tools":false,"kit":true}'::jsonb, 150.00, 'delivery',   owner_a)
  on conflict do nothing;

  -- ---------- 11. Orden de trabajo (Taller B) ----------
  insert into public.work_orders (id, shop_id, customer_id, vehicle_id, technician_id, mileage_in, status, created_by) values
    (wo_b1, shop_b, cust_b1, veh_b1, tech_b1, 80100, 'reception', owner_b)
  on conflict do nothing;

  -- ---------- 12. Movimientos de inventario (Taller A) → stock calculado ----------
  -- prod_a1: +10 compra, -2 consumo en wo_a2  => stock 8 (sobre threshold 5)
  -- prod_a2: +8  compra, -3 consumo en wo_a2  => stock 5 (en threshold 10 → below_threshold)
  insert into public.inventory_movements (id, shop_id, product_id, movement_type, quantity, unit_cost, work_order_id, created_by) values
    (mov_a1, shop_a, prod_a1, 'purchase',    10, 4.50, null,  owner_a),
    (mov_a2, shop_a, prod_a1, 'consumption', -2, null, wo_a2, owner_a),
    (mov_a3, shop_a, prod_a2, 'purchase',     8, 2.00, null,  owner_a),
    (mov_a4, shop_a, prod_a2, 'consumption', -3, null, wo_a2, owner_a)
  on conflict do nothing;

  -- ---------- 13. Subscriptions ----------
  insert into public.subscriptions (shop_id, provider, status, plan, current_period_end) values
    (shop_a, 'hotmart',       'active', 'standard', now() + interval '30 days'),
    (shop_b, 'bank_transfer', 'active', 'standard', now() + interval '30 days')
  on conflict do nothing;

  raise notice 'Seed determinista OK. Taller A = %, Taller B = %', shop_a, shop_b;
end $$;

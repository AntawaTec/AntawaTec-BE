-- =============================================================================
-- seed.sql  — Demo data for AntawaTec (2 shops) to test tenant isolation.
-- PREREQUISITE: create 3 users in Supabase Auth and paste their UIDs below.
--   admin@antawa.test  -> v_admin    (antawa_admin, no shop)
--   ownera@antawa.test -> v_owner_a  (shop_owner, Taller A)
--   ownerb@antawa.test -> v_owner_b  (shop_owner, Taller B)
-- Runs as a privileged role (service role) so RLS is bypassed during seeding.
-- Re-run safe-ish: it always inserts fresh rows (random UUIDs); to reset, see
-- the cleanup note at the bottom.
-- =============================================================================

do $$
declare
  -- ====== PASTE THE 3 AUTH USER UIDs HERE ======
  v_admin   uuid := 'PASTE-ADMIN-UID';
  v_owner_a uuid := 'PASTE-OWNER-A-UID';
  v_owner_b uuid := 'PASTE-OWNER-B-UID';
  -- =============================================

  shop_a uuid := gen_random_uuid();
  shop_b uuid := gen_random_uuid();

  tech_a1 uuid := gen_random_uuid();
  tech_a2 uuid := gen_random_uuid();
  tech_b1 uuid := gen_random_uuid();

  cust_a1 uuid := gen_random_uuid();
  cust_a2 uuid := gen_random_uuid();
  cust_b1 uuid := gen_random_uuid();

  veh_a1 uuid := gen_random_uuid();
  veh_a2 uuid := gen_random_uuid();
  veh_b1 uuid := gen_random_uuid();

  sup_a uuid := gen_random_uuid();

  prod_a1 uuid := gen_random_uuid();
  prod_a2 uuid := gen_random_uuid();
  prod_b1 uuid := gen_random_uuid();

  svc_a1 uuid := gen_random_uuid();

  quote_a1 uuid := gen_random_uuid();
  qsec_a1  uuid := gen_random_uuid();

  appt_a1 uuid := gen_random_uuid();

  wo_a1 uuid := gen_random_uuid();  -- reception
  wo_a2 uuid := gen_random_uuid();  -- in_process
  wo_a3 uuid := gen_random_uuid();  -- delivery
  wo_b1 uuid := gen_random_uuid();
begin
  -- ---------- Tenants ----------
  insert into public.shops (id, name, slug, status, contact_email, activated_at)
  values
    (shop_a, 'Taller A', 'taller-a', 'active', 'ownera@antawa.test', now()),
    (shop_b, 'Taller B', 'taller-b', 'active', 'ownerb@antawa.test', now());

  -- ---------- Profiles (link auth users to roles/shops) ----------
  insert into public.profiles (id, shop_id, role, full_name)
  values
    (v_admin,   null,   'antawa_admin', 'Admin Antawa'),
    (v_owner_a, shop_a, 'shop_owner',   'Dueño Taller A'),
    (v_owner_b, shop_b, 'shop_owner',   'Dueño Taller B');

  -- ---------- Technicians ----------
  insert into public.technicians (id, shop_id, full_name) values
    (tech_a1, shop_a, 'Juan Pérez'),
    (tech_a2, shop_a, 'Pedro Gómez'),
    (tech_b1, shop_b, 'Carlos Ruiz');

  -- ---------- Customers ----------
  insert into public.customers (id, shop_id, name, is_fleet, fleet_name, whatsapp_number) values
    (cust_a1, shop_a, 'Transportes Andinos', true,  'Flota Andinos', '+593990000001'),
    (cust_a2, shop_a, 'María López',          false, null,            '+593990000002'),
    (cust_b1, shop_b, 'José Torres',          false, null,            '+593990000003');

  -- ---------- Vehicles ----------
  insert into public.vehicles (id, shop_id, customer_id, make, model, year, plate, fuel_type, mileage) values
    (veh_a1, shop_a, cust_a1, 'Chevrolet', 'NPR',   2019, 'PBA-1234', 'diesel',   120000),
    (veh_a2, shop_a, cust_a2, 'Kia',       'Rio',   2021, 'PCD-5678', 'gasoline', 45000),
    (veh_b1, shop_b, cust_b1, 'Toyota',    'Hilux', 2020, 'PXY-9999', 'diesel',   80000);

  -- ---------- Inventory catalog ----------
  insert into public.suppliers (id, shop_id, name, phone) values
    (sup_a, shop_a, 'Repuestos Quito', '+59322000000');

  insert into public.products (id, shop_id, supplier_id, brand, model, name, uom, cost, suggested_price, threshold) values
    (prod_a1, shop_a, sup_a, 'Bosch', 'F026', 'Filtro de aceite', 'unit', 4.50,  9.00,  5),
    (prod_a2, shop_a, sup_a, 'NGK',   'BKR6', 'Bujía',            'unit', 2.00,  5.00,  10),
    (prod_b1, shop_b, null,  'Mann',  'C25',  'Filtro de aire',   'unit', 6.00,  12.00, 4);

  insert into public.services (id, shop_id, name, price) values
    (svc_a1, shop_a, 'Cambio de aceite', 15.00);

  -- ---------- Quotation (Shop A) ----------
  insert into public.quotes (id, shop_id, customer_id, vehicle_id, status, subtotal, tax, total, approved_at, created_by)
  values (quote_a1, shop_a, cust_a2, veh_a2, 'approved', 39.00, 5.85, 44.85, now(), v_owner_a);

  insert into public.quote_sections (id, shop_id, quote_id, section_type, subtotal)
  values (qsec_a1, shop_a, quote_a1, 'maintenance', 39.00);

  insert into public.quote_items (shop_id, quote_section_id, item_type, product_id, service_id, description, quantity, unit_price, line_total) values
    (shop_a, qsec_a1, 'part',  prod_a1, null,    'Filtro de aceite', 1, 9.00,  9.00),
    (shop_a, qsec_a1, 'part',  prod_a2, null,    'Bujía',            3, 5.00,  15.00),
    (shop_a, qsec_a1, 'labor', null,    svc_a1,  'Cambio de aceite', 1, 15.00, 15.00);

  -- ---------- Appointment (from the approved quote) ----------
  insert into public.appointments (id, shop_id, customer_id, vehicle_id, quote_id, scheduled_at, status, source)
  values (appt_a1, shop_a, cust_a2, veh_a2, quote_a1, now() + interval '1 day', 'confirmed', 'quote');

  -- ---------- Work orders across Kanban statuses (Shop A) ----------
  insert into public.work_orders (id, shop_id, customer_id, vehicle_id, appointment_id, technician_id, mileage_in, fuel_level, checklist, estimated_total, status, created_by) values
    (wo_a1, shop_a, cust_a1, veh_a1, null,    tech_a1, 120500, '1/2', '{"jack":true,"tools":true,"kit":false}'::jsonb, 80.00,  'reception',  v_owner_a),
    (wo_a2, shop_a, cust_a2, veh_a2, appt_a1, tech_a2, 45200,  '3/4', '{"jack":true,"tools":true,"kit":true}'::jsonb,  44.85,  'in_process', v_owner_a),
    (wo_a3, shop_a, cust_a1, veh_a1, null,    tech_a1, 119000, 'full','{"jack":true,"tools":false,"kit":true}'::jsonb, 150.00, 'delivery',   v_owner_a);

  -- ---------- Work order (Shop B) ----------
  insert into public.work_orders (id, shop_id, customer_id, vehicle_id, technician_id, mileage_in, status, created_by)
  values (wo_b1, shop_b, cust_b1, veh_b1, tech_b1, 80100, 'reception', v_owner_b);

  -- ---------- Inventory movements (Shop A) -> calculated stock ----------
  -- prod_a1: +10 purchase, -2 consumed on wo_a2  => stock 8 (above threshold 5)
  insert into public.inventory_movements (shop_id, product_id, movement_type, quantity, unit_cost, work_order_id, created_by) values
    (shop_a, prod_a1, 'purchase',     10, 4.50, null,  v_owner_a),
    (shop_a, prod_a1, 'consumption',  -2, null, wo_a2, v_owner_a),
    (shop_a, prod_a2, 'purchase',      8, 2.00, null,  v_owner_a),
    (shop_a, prod_a2, 'consumption',  -3, null, wo_a2, v_owner_a);  -- prod_a2: 5, at threshold 10 => below_threshold = true

  -- ---------- Subscriptions ----------
  insert into public.subscriptions (shop_id, provider, status, plan, current_period_end) values
    (shop_a, 'hotmart',       'active', 'standard', now() + interval '30 days'),
    (shop_b, 'bank_transfer', 'active', 'standard', now() + interval '30 days');

  raise notice 'Seed complete. Shop A = %, Shop B = %', shop_a, shop_b;
end $$;

-- -----------------------------------------------------------------------------
-- CLEANUP (optional): wipe all seeded data. Order respects FKs via cascade.
-- Deleting the two shops cascades to all their child rows. Profiles cascade
-- from auth.users, so delete the test users from the dashboard separately.
--   delete from public.shops where slug in ('taller-a','taller-b');
-- -----------------------------------------------------------------------------

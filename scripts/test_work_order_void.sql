-- Batería de validación de 0055 (anular / reactivar una orden de trabajo).
-- Correr tras `supabase db reset` (necesita el seed determinista de supabase/seed.sql):
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f scripts/test_work_order_void.sql
-- Auto-verificable: cada caso lanza 'FALLO n: …' si no se cumple; al final
-- imprime OK y hace ROLLBACK (no deja nada escrito).
--
-- Los casos con identidad (dueño A, dueño B, técnico con login) cambian de rol
-- DENTRO de la transacción (`role` + `request.jwt.claims`, lo mismo que hace
-- PostgREST), así que la RLS y current_shop_id() actúan de verdad. Las
-- verificaciones de estado corren como postgres (sin RLS).
--
-- GOTCHA (igual que test_time_logs.sql): dentro de una transacción now() está
-- CONGELADO. La sesión de tiempo de prueba nace con started_at en el pasado.
\set ON_ERROR_STOP on

begin;

-- ---------- helpers (pg_temp: mueren con la sesión) ----------
create function pg_temp.as_user(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function pg_temp.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Ejecuta p_sql con el rol ACTUAL y exige que falle con (sqlstate, hint).
create function pg_temp.expect_error(p_label text, p_sql text, p_state text, p_hint text)
returns void language plpgsql as $$
declare
  v_state text;
  v_hint  text;
  v_msg   text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_hint = pg_exception_hint, v_msg = message_text;
    if v_state <> p_state or coalesce(v_hint, '') <> coalesce(p_hint, '') then
      raise exception 'FALLO %: esperaba %/% y vino %/% (%)', p_label, p_state, p_hint, v_state, v_hint, v_msg;
    end if;
    return;
  end;
  raise exception 'FALLO %: la sentencia NO falló: %', p_label, p_sql;
end $$;

create function pg_temp.stock(p_product uuid) returns numeric language sql as $$
  select coalesce(sum(quantity), 0) from public.inventory_movements where product_id = p_product
$$;

grant execute on all functions in schema pg_temp to authenticated;

do $$
declare
  -- Seed determinista (supabase/seed.sql)
  v_owner_a  uuid := 'a0000000-0000-4000-a000-000000000001';
  v_owner_b  uuid := 'b0000000-0000-4000-a000-000000000001';
  v_tech_uid uuid := 'a0000000-0000-4000-a000-0000000000c1'; -- login de tech_a1
  v_shop_a   uuid := 'a1000000-0000-4000-a000-000000000001';
  v_tech_a2  uuid := 'a2000000-0000-4000-a000-000000000002';
  v_prod_a1  uuid := 'a6000000-0000-4000-a000-000000000001';
  v_prod_a2  uuid := 'a6000000-0000-4000-a000-000000000002';
  v_cust_a1  uuid := 'a3000000-0000-4000-a000-000000000001';
  v_appt_a1  uuid := 'ab000000-0000-4000-a000-000000000001';
  v_wo_a1    uuid := 'ac000000-0000-4000-a000-000000000001'; -- reception, tech_a1 (con login)
  v_wo_a2    uuid := 'ac000000-0000-4000-a000-000000000002'; -- in_process, consumos −2 / −3, cita appt_a1
  v_wo_a3    uuid := 'ac000000-0000-4000-a000-000000000003'; -- delivery, tech_a1
  v_s1_0     numeric;  -- stock de prod_a1 ANTES de todo
  v_s2_0     numeric;
  v_s1_free  numeric;  -- stock que quedaría sin los consumos de wo_a2
  v_s2_free  numeric;
  v_log      uuid;
  v_n_q      uuid;
  v_n_f      uuid;
  v_n_s      uuid;
  v_inv      uuid;
  v_mov      uuid;
  v_wo       public.work_orders;
  v_n        int;
  v_cost     numeric;
begin
  -- ===== Preparación (postgres) =====
  -- Un consumo con costo en wo_a2 (prod_a1: −2 sin costo + −1 a 6.00 → promedio
  -- ponderado de los que tienen costo = 6.00).
  insert into public.inventory_movements (shop_id, product_id, movement_type, quantity, unit_cost, work_order_id)
    values (v_shop_a, v_prod_a1, 'consumption', -1, 6.00, v_wo_a2);
  v_s1_0 := pg_temp.stock(v_prod_a1);
  v_s2_0 := pg_temp.stock(v_prod_a2);
  v_s1_free := v_s1_0 + 3;  -- −2 −1 de wo_a2
  v_s2_free := v_s2_0 + 3;  -- −3 de wo_a2

  -- Sesión corriendo en wo_a2.
  insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at)
    values (v_shop_a, v_wo_a2, v_tech_a2, now() - interval '1 hour')
    returning id into v_log;

  -- Avisos de wo_a2: uno en cola, uno reintentable, uno ya enviado.
  insert into public.notification_log (shop_id, channel, template, related_entity_type, related_entity_id, status, attempts)
    values (v_shop_a, 'email', 'work_in_process', 'work_order', v_wo_a2, 'queued', 0) returning id into v_n_q;
  insert into public.notification_log (shop_id, channel, template, related_entity_type, related_entity_id, status, attempts)
    values (v_shop_a, 'whatsapp', 'vehicle_received', 'work_order', v_wo_a2, 'failed', 2) returning id into v_n_f;
  insert into public.notification_log (shop_id, channel, template, related_entity_type, related_entity_id, status, attempts, sent_at)
    values (v_shop_a, 'email', 'vehicle_received', 'work_order', v_wo_a2, 'sent', 1, now()) returning id into v_n_s;

  -- Factura AUTORIZADA colgada de wo_a3.
  insert into public.invoices (shop_id, work_order_id, customer_id, status, buyer_id_type, buyer_id_number, buyer_name)
    values (v_shop_a, v_wo_a3, v_cust_a1, 'authorized', 'cedula', '1710034065', 'Cliente de prueba')
    returning id into v_inv;

  -- ===== 1) Privilegios: anon no ejecuta, authenticated sí =====
  if has_function_privilege('anon', 'public.void_work_order(uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.reactivate_work_order(uuid)', 'execute') then
    raise exception 'FALLO 1: anon puede ejecutar las RPC';
  end if;
  if not has_function_privilege('authenticated', 'public.void_work_order(uuid, text)', 'execute') then
    raise exception 'FALLO 1b: authenticated no puede ejecutar void_work_order';
  end if;

  -- ===== 2) Técnico: no anula ni su orden asignada, ni toca voided_* directo =====
  perform pg_temp.as_user(v_tech_uid);
  perform pg_temp.expect_error('2a técnico anula',
    format('select public.void_work_order(%L, %L)', v_wo_a1, 'x'), '42501', 'not_owner');
  perform pg_temp.expect_error('2b técnico UPDATE voided_at',
    format('update public.work_orders set voided_at = now(), void_reason = %L where id = %L', 'x', v_wo_a1),
    '42501', 'void_columns_protected');
  -- Control: el técnico SÍ puede actualizar su orden activa (la guardia no rompe 0022).
  update public.work_orders set mileage_in = 120501 where id = v_wo_a1;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FALLO 2c: el técnico ya no puede actualizar su orden activa'; end if;
  perform pg_temp.as_postgres();

  -- ===== 3) Dueño de OTRO taller → not_found =====
  perform pg_temp.as_user(v_owner_b);
  perform pg_temp.expect_error('3 dueño B anula orden de A',
    format('select public.void_work_order(%L, %L)', v_wo_a2, 'x'), 'PT404', 'not_found');
  perform pg_temp.as_postgres();

  -- ===== 4) Dueño A: motivo vacío, UPDATE directo, insert anulado =====
  perform pg_temp.as_user(v_owner_a);
  perform pg_temp.expect_error('4a motivo vacío',
    format('select public.void_work_order(%L, %L)', v_wo_a2, '   '), '22023', 'reason_required');
  perform pg_temp.expect_error('4b motivo null',
    format('select public.void_work_order(%L, null)', v_wo_a2), '22023', 'reason_required');
  perform pg_temp.expect_error('4c dueño UPDATE voided_at',
    format('update public.work_orders set voided_at = now(), void_reason = %L where id = %L', 'x', v_wo_a2),
    '42501', 'void_columns_protected');
  perform pg_temp.expect_error('4d orden que nace anulada',
    format('insert into public.work_orders (shop_id, customer_id, vehicle_id, voided_at, void_reason) '
           'select shop_id, customer_id, vehicle_id, now(), %L from public.work_orders where id = %L', 'x', v_wo_a2),
    '42501', 'void_columns_protected');
  perform pg_temp.expect_error('4e reactivar una orden activa',
    format('select public.reactivate_work_order(%L)', v_wo_a2), 'PT409', 'not_voided');

  -- ===== 5) Anular wo_a2 =====
  v_wo := public.void_work_order(v_wo_a2, '  Orden duplicada  ');
  perform pg_temp.as_postgres();
  if v_wo.voided_at is null or v_wo.voided_by is distinct from v_owner_a or v_wo.void_reason <> 'Orden duplicada' then
    raise exception 'FALLO 5a: columnas de anulación mal (% / % / %)', v_wo.voided_at, v_wo.voided_by, v_wo.void_reason;
  end if;
  if v_wo.status <> 'in_process' then
    raise exception 'FALLO 5b: anular cambió el status (%)', v_wo.status;
  end if;
  -- Stock devuelto EXACTO.
  if pg_temp.stock(v_prod_a1) <> v_s1_free or pg_temp.stock(v_prod_a2) <> v_s2_free then
    raise exception 'FALLO 5c: stock tras anular = % / %, esperaba % / %',
      pg_temp.stock(v_prod_a1), pg_temp.stock(v_prod_a2), v_s1_free, v_s2_free;
  end if;
  -- Un ajuste por producto, con work_order_id y nota legible; costo promedio.
  select count(*) into v_n from public.inventory_movements
   where work_order_id = v_wo_a2 and movement_type = 'adjustment'
     and notes like 'Devolución por anulación de la orden OT-%';
  if v_n <> 2 then raise exception 'FALLO 5d: % ajustes de devolución (esperaba 2)', v_n; end if;
  select unit_cost into v_cost from public.inventory_movements
   where work_order_id = v_wo_a2 and movement_type = 'adjustment' and product_id = v_prod_a1;
  if v_cost is distinct from 6.00 then raise exception 'FALLO 5e: unit_cost del ajuste = % (esperaba 6.00)', v_cost; end if;
  select unit_cost into v_cost from public.inventory_movements
   where work_order_id = v_wo_a2 and movement_type = 'adjustment' and product_id = v_prod_a2;
  if v_cost is not null then raise exception 'FALLO 5f: unit_cost sin consumos con costo = % (esperaba null)', v_cost; end if;
  -- Sesión cerrada.
  if (select ended_at from public.work_order_time_logs where id = v_log) is null then
    raise exception 'FALLO 5g: la sesión de tiempo sigue corriendo';
  end if;
  -- Avisos: los dos pendientes fuera del drenado; el enviado intacto.
  select count(*) into v_n from public.notification_log
   where id in (v_n_q, v_n_f) and status = 'failed' and attempts >= 5
     and error = 'cancelada: la orden fue anulada' and payload ->> 'cancelled' = 'work_order_voided';
  if v_n <> 2 then raise exception 'FALLO 5h: % avisos cancelados (esperaba 2)', v_n; end if;
  if (select status from public.notification_log where id = v_n_s) <> 'sent' then
    raise exception 'FALLO 5i: se tocó un aviso ya enviado';
  end if;
  -- Bitácora.
  if not exists (select 1 from public.work_order_logs
                  where work_order_id = v_wo_a2 and notes = 'Orden anulada. Motivo: Orden duplicada'
                    and created_by = v_owner_a) then
    raise exception 'FALLO 5j: falta la entrada de bitácora de la anulación';
  end if;

  -- ===== 6) Orden anulada: doble anulación y escrituras bloqueadas =====
  perform pg_temp.as_user(v_owner_a);
  perform pg_temp.expect_error('6a doble anulación',
    format('select public.void_work_order(%L, %L)', v_wo_a2, 'otra vez'), 'PT409', 'already_voided');
  perform pg_temp.expect_error('6b UPDATE de status',
    format('update public.work_orders set status = %L where id = %L', 'delivery', v_wo_a2), 'PT409', 'work_order_voided');
  perform pg_temp.expect_error('6c UPDATE sin cambios',
    format('update public.work_orders set status = status where id = %L', v_wo_a2), 'PT409', 'work_order_voided');
  perform pg_temp.expect_error('6d des-anular a mano',
    format('update public.work_orders set voided_at = null, voided_by = null, void_reason = null where id = %L', v_wo_a2),
    'PT409', 'work_order_voided');
  perform pg_temp.expect_error('6e consumo nuevo',
    format('insert into public.inventory_movements (shop_id, product_id, movement_type, quantity, work_order_id) '
           'values (%L, %L, %L, -1, %L)', v_shop_a, v_prod_a1, 'consumption', v_wo_a2), 'PT409', 'work_order_voided');
  select id into v_mov from public.inventory_movements
   where work_order_id = v_wo_a2 and movement_type = 'consumption' limit 1;
  perform pg_temp.expect_error('6f editar consumo',
    format('update public.inventory_movements set quantity = -5 where id = %L', v_mov), 'PT409', 'work_order_voided');
  perform pg_temp.expect_error('6g borrar consumo',
    format('delete from public.inventory_movements where id = %L', v_mov), 'PT409', 'work_order_voided');
  perform pg_temp.expect_error('6h sesión de tiempo nueva',
    format('insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at) '
           'values (%L, %L, %L, now() - interval %L)', v_shop_a, v_wo_a2, v_tech_a2, '5 minutes'),
    'PT409', 'work_order_voided');
  -- Un movimiento SIN orden (compra) sigue entrando normal.
  insert into public.inventory_movements (shop_id, product_id, movement_type, quantity, unit_cost)
    values (v_shop_a, v_prod_a1, 'purchase', 1, 4.50);
  perform pg_temp.as_postgres();
  -- La guardia vale también para service_role / postgres.
  perform pg_temp.expect_error('6i UPDATE como postgres',
    format('update public.work_orders set mileage_in = 1 where id = %L', v_wo_a2), 'PT409', 'work_order_voided');
  v_s1_free := v_s1_free + 1;  -- la compra de arriba
  v_s1_0    := v_s1_0 + 1;

  -- ===== 7) Cascada ON DELETE SET NULL sobre una orden anulada SÍ pasa =====
  delete from public.appointments where id = v_appt_a1;
  if (select appointment_id from public.work_orders where id = v_wo_a2) is not null then
    raise exception 'FALLO 7: la cascada no anuló appointment_id';
  end if;

  -- ===== 8) Técnico sobre su orden asignada ANULADA =====
  perform pg_temp.as_user(v_owner_a);
  perform public.void_work_order(v_wo_a1, 'Prueba técnico');
  perform pg_temp.as_user(v_tech_uid);
  perform pg_temp.expect_error('8a técnico edita orden anulada',
    format('update public.work_orders set mileage_in = 1 where id = %L', v_wo_a1), 'PT409', 'work_order_voided');
  perform pg_temp.expect_error('8b técnico reactiva',
    format('select public.reactivate_work_order(%L)', v_wo_a1), '42501', 'not_owner');
  perform pg_temp.as_user(v_owner_a);
  perform public.reactivate_work_order(v_wo_a1);
  perform pg_temp.as_postgres();

  -- ===== 9) Reactivar wo_a2: re-descuento exacto =====
  perform pg_temp.as_user(v_owner_a);
  v_wo := public.reactivate_work_order(v_wo_a2);
  perform pg_temp.as_postgres();
  if v_wo.voided_at is not null or v_wo.voided_by is not null or v_wo.void_reason is not null then
    raise exception 'FALLO 9a: reactivar no limpió las columnas';
  end if;
  if pg_temp.stock(v_prod_a1) <> v_s1_0 or pg_temp.stock(v_prod_a2) <> v_s2_0 then
    raise exception 'FALLO 9b: stock tras reactivar = % / %, esperaba % / %',
      pg_temp.stock(v_prod_a1), pg_temp.stock(v_prod_a2), v_s1_0, v_s2_0;
  end if;
  select count(*) into v_n from public.inventory_movements
   where work_order_id = v_wo_a2 and movement_type = 'adjustment'
     and notes like 'Re-descuento por reactivación de la orden OT-%';
  if v_n <> 2 then raise exception 'FALLO 9c: % ajustes de re-descuento (esperaba 2)', v_n; end if;
  if (select ended_at from public.work_order_time_logs where id = v_log) is null then
    raise exception 'FALLO 9d: reactivar reabrió la sesión de tiempo';
  end if;
  if exists (select 1 from public.notification_log where id in (v_n_q, v_n_f) and status <> 'failed') then
    raise exception 'FALLO 9e: reactivar revivió avisos cancelados';
  end if;
  if not exists (select 1 from public.work_order_logs where work_order_id = v_wo_a2 and notes = 'Orden reactivada') then
    raise exception 'FALLO 9f: falta la entrada de bitácora de la reactivación';
  end if;
  if not exists (select 1 from public.work_order_logs where work_order_id = v_wo_a2 and notes like 'Orden anulada.%') then
    raise exception 'FALLO 9g: la entrada de la anulación no sobrevivió a la reactivación';
  end if;

  -- ===== 10) Ciclo: editar consumo tras reactivar → anular devuelve el neto NUEVO =====
  perform pg_temp.as_user(v_owner_a);
  update public.inventory_movements set quantity = -4
   where work_order_id = v_wo_a2 and product_id = v_prod_a2 and movement_type = 'consumption';
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'FALLO 10a: no se pudo editar el consumo de la orden reactivada'; end if;
  perform public.void_work_order(v_wo_a2, 'Segunda anulación');
  perform pg_temp.as_postgres();
  if pg_temp.stock(v_prod_a1) <> v_s1_free or pg_temp.stock(v_prod_a2) <> v_s2_free then
    raise exception 'FALLO 10b: stock tras la 2ª anulación = % / %, esperaba % / %',
      pg_temp.stock(v_prod_a1), pg_temp.stock(v_prod_a2), v_s1_free, v_s2_free;
  end if;
  perform pg_temp.as_user(v_owner_a);
  perform public.reactivate_work_order(v_wo_a2);
  perform pg_temp.as_postgres();
  if pg_temp.stock(v_prod_a1) <> v_s1_0 or pg_temp.stock(v_prod_a2) <> v_s2_0 - 1 then
    raise exception 'FALLO 10c: stock tras la 2ª reactivación = % / %, esperaba % / %',
      pg_temp.stock(v_prod_a1), pg_temp.stock(v_prod_a2), v_s1_0, v_s2_0 - 1;
  end if;

  -- ===== 11) Bloqueo por factura emitida =====
  perform pg_temp.as_user(v_owner_a);
  perform pg_temp.expect_error('11a factura autorizada',
    format('select public.void_work_order(%L, %L)', v_wo_a3, 'x'), 'PT409', 'has_issued_invoice');
  perform pg_temp.as_postgres();
  update public.invoices set status = 'processing' where id = v_inv;
  perform pg_temp.as_user(v_owner_a);
  perform pg_temp.expect_error('11b factura en emisión',
    format('select public.void_work_order(%L, %L)', v_wo_a3, 'x'), 'PT409', 'has_issued_invoice');
  perform pg_temp.as_postgres();
  -- Anulada en el SRI (voided) → ya no bloquea.
  update public.invoices set status = 'voided', voided_at = now() where id = v_inv;
  perform pg_temp.as_user(v_owner_a);
  v_wo := public.void_work_order(v_wo_a3, 'Factura anulada en el SRI');
  perform pg_temp.as_postgres();
  if v_wo.voided_at is null then raise exception 'FALLO 11c: no anuló con la factura ya anulada'; end if;

  -- ===== 12) Borrar el usuario que anuló (y creó) la orden: cascadas SET NULL =====
  -- (deleteUser de technician-access / baja de un dueño no puede trabarse en una
  -- orden anulada.) wo_b1 la creó owner_b; la anula él y después se borra su login.
  perform pg_temp.as_user(v_owner_b);
  perform public.void_work_order('bc000000-0000-4000-a000-000000000001', 'Prueba de cascada');
  perform pg_temp.as_postgres();
  delete from auth.users where id = v_owner_b;
  select * into v_wo from public.work_orders where id = 'bc000000-0000-4000-a000-000000000001';
  if v_wo.voided_by is not null or v_wo.created_by is not null or v_wo.voided_at is null then
    raise exception 'FALLO 12: cascada de auth.users mal (voided_by=%, created_by=%, voided_at=%)',
      v_wo.voided_by, v_wo.created_by, v_wo.voided_at;
  end if;

  raise notice 'test_work_order_void: OK (todos los casos)';
end;
$$;

rollback;

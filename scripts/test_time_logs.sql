-- Batería de validación de 0027 (work_order_time_logs). Correr tras `supabase db reset`:
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f scripts/test_time_logs.sql
-- Corre como rol privilegiado (bypassa RLS): valida constraints/RPC/índices.
-- Los casos CON RLS (técnico no cronometra a nombre de otro, etc.) van en la
-- rebanada real-JWT del FE (technician-isolation.itest.ts).
--
-- GOTCHA deliberado: dentro de una transacción now() está CONGELADO — un
-- insert con default y un stop en la misma tx darían ended_at = started_at y
-- violarían el CHECK (>). Por eso los inserts de prueba fijan
-- started_at = now() - interval '1 minute'. En producción no aplica: start y
-- stop son requests (transacciones) distintas.
\set ON_ERROR_STOP on

begin;

do $$
declare
  v_shop_a uuid := 'a1000000-0000-4000-a000-000000000001'; -- Taller A (seed)
  v_shop_b uuid := 'b1000000-0000-4000-a000-000000000001'; -- Taller B (seed)
  v_wo_a   uuid := 'ac000000-0000-4000-a000-000000000001'; -- orden de A (seed)
  v_wo_a2  uuid := 'ac000000-0000-4000-a000-000000000002'; -- otra orden de A (seed)
  v_wo_b   uuid := 'bc000000-0000-4000-a000-000000000001'; -- orden de B (seed)
  v_tech_a uuid;
  v_tech_b uuid;
  v_log    uuid;
  v_row    public.work_order_time_logs;
  v_err    text;
begin
  select id into v_tech_a from public.technicians where shop_id = v_shop_a limit 1;
  select id into v_tech_b from public.technicians where shop_id = v_shop_b limit 1;
  if v_tech_a is null or v_tech_b is null then
    raise exception 'seed sin técnicos en A o B — revisar seed.sql';
  end if;

  -- 1) Feliz: insert sin started_at → default poblado; sesión corriendo.
  insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at)
    values (v_shop_a, v_wo_a, v_tech_a, now() - interval '1 minute')
    returning id into v_log;
  if (select started_at from public.work_order_time_logs where id = v_log) is null then
    raise exception 'FALLO 1: started_at no poblada';
  end if;

  -- 2) Segunda sesión corriendo del MISMO técnico (otra orden) → 23505.
  begin
    insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at)
      values (v_shop_a, v_wo_a2, v_tech_a, now() - interval '1 minute');
    raise exception 'FALLO 2: segunda sesión corriendo del mismo técnico ENTRÓ';
  exception when unique_violation then
    get stacked diagnostics v_err = constraint_name;
    if v_err <> 'work_order_time_logs_running_uq' then
      raise exception 'FALLO 2b: 23505 de otro índice: %', v_err;
    end if;
  end;

  -- 3) La RPC cierra con hora del server y ended_at > started_at.
  v_row := public.stop_work_time_log(v_log);
  if v_row.ended_at is null or v_row.ended_at <= v_row.started_at then
    raise exception 'FALLO 3: RPC no cerró bien (ended_at=%)', v_row.ended_at;
  end if;

  -- 4) Cerrada la primera, la "segunda" del mismo técnico ahora SÍ entra.
  insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at)
    values (v_shop_a, v_wo_a2, v_tech_a, now() - interval '1 minute')
    returning id into v_log;
  perform public.stop_work_time_log(v_log);

  -- 5) RPC sobre sesión YA CERRADA → P0002.
  begin
    perform public.stop_work_time_log(v_log);
    raise exception 'FALLO 5: RPC sobre sesión cerrada no tiró';
  exception when no_data_found then null;
  end;

  -- 6) RPC sobre uuid inexistente → P0002.
  begin
    perform public.stop_work_time_log(gen_random_uuid());
    raise exception 'FALLO 6: RPC sobre uuid inexistente no tiró';
  exception when no_data_found then null;
  end;

  -- 7) CHECK del span: ended_at = started_at → 23514 (borde del >).
  begin
    update public.work_order_time_logs set ended_at = started_at where id = v_log;
    raise exception 'FALLO 7: ended_at = started_at ENTRÓ';
  exception when check_violation then null;
  end;

  -- 8) CHECK del span: ended_at < started_at → 23514.
  begin
    update public.work_order_time_logs
      set ended_at = started_at - interval '1 second' where id = v_log;
    raise exception 'FALLO 8: ended_at < started_at ENTRÓ';
  exception when check_violation then null;
  end;

  -- 9) Cross-tenant por el FK de la ORDEN: shop A + orden de B → 23503.
  begin
    insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at)
      values (v_shop_a, v_wo_b, v_tech_a, now() - interval '1 minute');
    raise exception 'FALLO 9: sesión con orden de otro taller ENTRÓ';
  exception when foreign_key_violation then null;
  end;

  -- 10) Cross-tenant por el FK del TÉCNICO: shop A + técnico de B → 23503.
  begin
    insert into public.work_order_time_logs (shop_id, work_order_id, technician_id, started_at)
      values (v_shop_a, v_wo_a, v_tech_b, now() - interval '1 minute');
    raise exception 'FALLO 10: sesión con técnico de otro taller ENTRÓ';
  exception when foreign_key_violation then null;
  end;

  raise notice 'test_time_logs: 10/10 OK';
end $$;

rollback;

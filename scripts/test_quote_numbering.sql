-- =============================================================================
-- scripts/test_quote_numbering.sql
-- Prueba de aceptación para 0012 (correlativo de cotización por taller).
-- Tooling de desarrollo — NO lo corre el CLI. Read-only en efecto: crea datos
-- desechables y hace ROLLBACK al final, así que no deja rastro (ni filas en el
-- contador private.shop_quote_counters).
--
-- CÓMO CORRERLO (stack local, como rol PRIVILEGIADO — postgres/service_role, que
-- saltea RLS; este script inserta en public.shops, que no tiene policy de INSERT):
--   supabase db reset                 # aplica 0001..0016
--   psql "$(supabase status -o env | grep DB_URL | cut -d= -f2-)" \
--        -f scripts/test_quote_numbering.sql
-- o pega el contenido en el SQL editor del dashboard local.
--
-- Valida los criterios de aceptación #1 (correlativo independiente por taller) y,
-- de paso, el sentinela DEFAULT 0 y el camino de import (número explícito + greatest).
-- La concurrencia real (dos transacciones simultáneas) NO se puede probar en una
-- sola sesión SQL; ver la nota al final para el procedimiento con dos sesiones psql.
-- =============================================================================

\set ON_ERROR_STOP on

begin;

do $$
declare
  shop_a uuid := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  shop_b uuid := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  cust_a uuid;
  cust_b uuid;
  veh_a  uuid;
  veh_b  uuid;
  q1 int; q2 int; q3 int;
  n  int;
begin
  -- ---- setup: dos talleres desechables + un cliente/vehículo cada uno --------
  insert into public.shops (id, name, slug, status)
  values (shop_a, 'TEST SHOP A', 'test-shop-a-zz', 'active'),
         (shop_b, 'TEST SHOP B', 'test-shop-b-zz', 'active');

  insert into public.customers (shop_id, name) values (shop_a, 'Cliente A') returning id into cust_a;
  insert into public.customers (shop_id, name) values (shop_b, 'Cliente B') returning id into cust_b;
  insert into public.vehicles (shop_id, customer_id) values (shop_a, cust_a) returning id into veh_a;
  insert into public.vehicles (shop_id, customer_id) values (shop_b, cust_b) returning id into veh_b;

  -- ---- CHECK 1: correlativo por taller -------------------------------------
  -- Camino FE: se omite quote_number => llega el DEFAULT 0 => el trigger asigna.
  -- Esperado: A => 1, 2 ; B => 1 (conteos independientes).
  insert into public.quotes (shop_id, customer_id, vehicle_id)
    values (shop_a, cust_a, veh_a) returning quote_number into q1;
  insert into public.quotes (shop_id, customer_id, vehicle_id)
    values (shop_a, cust_a, veh_a) returning quote_number into q2;
  insert into public.quotes (shop_id, customer_id, vehicle_id)
    values (shop_b, cust_b, veh_b) returning quote_number into q3;

  if q1 <> 1 or q2 <> 2 then
    raise exception 'CHECK 1 FALLO: taller A esperaba 1,2 y obtuvo %, %', q1, q2;
  end if;
  if q3 <> 1 then
    raise exception 'CHECK 1 FALLO: taller B esperaba 1 y obtuvo %', q3;
  end if;
  raise notice 'CHECK 1 OK: A=>1,2  B=>1  (correlativo independiente por taller)';

  -- ---- CHECK 2: el 0 explícito es sentinela, no se guarda --------------------
  -- Si el trigger guardara 0, chocaría/duplicaría; debe asignar el siguiente (3).
  insert into public.quotes (shop_id, customer_id, vehicle_id, quote_number)
    values (shop_a, cust_a, veh_a, 0) returning quote_number into n;
  if n <> 3 then
    raise exception 'CHECK 2 FALLO: quote_number=0 debia tratarse como sentinela y asignar 3, obtuvo %', n;
  end if;
  raise notice 'CHECK 2 OK: quote_number=0 (DEFAULT/sentinela) asigno 3, no guardo 0';

  -- ---- CHECK 3: camino import (service_role) conserva un número > 0 ----------
  -- y adelanta el contador con greatest() para no colisionar después.
  insert into public.quotes (shop_id, customer_id, vehicle_id, quote_number)
    values (shop_a, cust_a, veh_a, 100) returning quote_number into n;
  if n <> 100 then
    raise exception 'CHECK 3a FALLO: numero explicito 100 no se conservo, obtuvo %', n;
  end if;
  insert into public.quotes (shop_id, customer_id, vehicle_id)
    values (shop_a, cust_a, veh_a) returning quote_number into n;
  if n <> 101 then
    raise exception 'CHECK 3b FALLO: tras importar 100, el siguiente auto debia ser 101, obtuvo %', n;
  end if;
  raise notice 'CHECK 3 OK: import conservo 100 y el contador avanzo => siguiente=101';

  -- ---- CHECK 4: sin duplicados (shop_id, quote_number) ----------------------
  -- El UNIQUE ya lo garantiza (un duplicado habría abortado el insert antes);
  -- esta consulta lo confirma de forma independiente.
  select count(*) into n from (
    select 1
    from public.quotes
    where shop_id in (shop_a, shop_b)
    group by shop_id, quote_number
    having count(*) > 1
  ) dups;
  if n <> 0 then
    raise exception 'CHECK 4 FALLO: existen % combinaciones (shop_id, quote_number) duplicadas', n;
  end if;
  raise notice 'CHECK 4 OK: sin duplicados (shop_id, quote_number)';

  raise notice '====== TODOS LOS CHECKS PASARON (se hace ROLLBACK a continuacion) ======';
end;
$$;

rollback;

-- =============================================================================
-- CONCURRENCIA (criterio #1, segunda mitad) — procedimiento manual, dos sesiones:
--   Sesión 1:  begin;  insert into public.quotes (shop_id, customer_id, vehicle_id)
--                       values ('<shop>', '<cust>', '<veh>') returning quote_number;
--   Sesión 2:  begin;  insert into public.quotes (...) returning quote_number;
--   La Sesión 2 se BLOQUEA en el row-lock del contador del taller hasta que la
--   Sesión 1 haga commit/rollback; luego obtiene el número siguiente. Nunca hay
--   duplicado. (Hacer rollback en ambas para no dejar datos.) Alternativa
--   automatizada: pgbench con un script de insert concurrente sobre el mismo taller
--   y luego verificar 0 duplicados con la consulta del CHECK 4.
-- =============================================================================

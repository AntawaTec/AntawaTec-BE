-- =============================================================================
-- scripts/backfill_vehicle_mileage.sql
-- Backfill único de vehicles.mileage a partir del km registrado en las órdenes.
-- Tooling operativo — NO lo corre el CLI y NO es una migración (las migraciones
-- son inmutables y corren en cada entorno; esto es una corrección de datos
-- puntual de prod, por eso vive en scripts/).
--
-- POR QUÉ EXISTE:
--   El import de Zoho de DC y GreenWash no trajo Datos_Vehiculo.Kilometraje
--   (esos talleres no lo llenaban en la ficha del vehículo), así que quedaron
--   ~657 vehículos con vehicles.mileage NULL aunque sus órdenes SÍ tienen km
--   (work_orders.mileage_in, work_order_deliveries.final_mileage,
--   work_order_logs.mileage). Desde la feature "kilometraje obligatorio" el FE
--   usa vehicles.mileage como último registro conocido: hint en el wizard y
--   PISO de validación (no se acepta un km menor). Con NULL el piso no existe y
--   el hint queda vacío, así que rellenamos con el MÁXIMO km que aparece en
--   cualquier orden del vehículo.
--
-- QUÉ HACE:
--   1. Junta el km de las 3 fuentes por vehículo (las tablas hijas no tienen
--      vehicle_id: se unen vía work_orders.vehicle_id). Solo km > 0.
--   2. Solo considera vehículos vivos (deleted_at is null) cuyo mileage es NULL
--      o 0. Nunca pisa un km ya cargado.
--   3. TOPE DE PLAUSIBILIDAD: descarta toda fuente con km >= 1.000.000.
--      work_order_logs.mileage viene de texto libre de Zoho y un dedo de más
--      (1200000 en vez de 120000) inflaría vehicles.mileage; como el FE lo usa
--      de PISO DURO al crear órdenes, el vehículo quedaría bloqueado en
--      recepción. Ningún auto de taller supera el millón de km, así que el tope
--      no descarta datos reales. El km elegido es el max() de lo que queda.
--   4. Reporta: total a actualizar, desglose por taller (nombre, cantidad, min,
--      max), cuántos vehículos sin km NO tienen fuente para rellenar,
--      ATÍPICOS EXCLUIDOS (vehículos con alguna fuente >= 1.000.000: taller,
--      placa, km descartado; revisarlos a mano — si tenían otra fuente válida
--      igual se rellenan con ella) y SOSPECHOSOS (candidatos cuyo km elegido
--      supera en más de 3x el mileage_in de su orden más reciente con km; NO
--      se excluyen, solo se listan para revisión manual).
--   5. Hace el UPDATE y avisa cuántas filas tocó (RAISE NOTICE).
--   updated_at lo bumpea el trigger set_updated_at de vehicles.
--
-- IDEMPOTENTE: el filtro coalesce(mileage,0)=0 hace que una segunda corrida
--   (después del commit) reporte 0 candidatos y no actualice nada.
--
-- CÓMO CORRERLO (UNA vez, A MANO, en prod):
--   Con rol PRIVILEGIADO (postgres/service_role): el SQL editor del dashboard de
--   Supabase o psql con la connection string de postgres. Ese rol saltea RLS,
--   que es lo que queremos (cruza todos los talleres). Con un rol normal
--   (authenticated) el RLS lo limitaría al taller del usuario.
--   Sin meta-comandos de psql a propósito, para que se pueda pegar tal cual en
--   el SQL editor. OJO: el SQL editor solo muestra el resultado de la última
--   sentencia; para ver los 5 reportes usá psql (`psql "<conn>" -f ...`) o
--   seleccioná cada reporte y correlo aparte (son read-only). El UPDATE además
--   deja el total y el desglose por taller como NOTICE.
--
--   DRY-RUN POR DEFECTO: termina en ROLLBACK. Correlo, revisá los reportes
--   (esperado ≈ 262 GW + 395 DC candidatos, menos los "sin fuente") y, para
--   aplicar, cambiá la ÚLTIMA línea `rollback;` por `commit;` y volvé a correr.
-- =============================================================================

begin;

-- Todas las fuentes de km (> 0) de los vehículos candidatos, sin tope todavía
-- (el tope se aplica abajo; acá se conservan los atípicos para reportarlos).
create temp table _mileage_sources on commit drop as
with km_sources as (
  select wo.vehicle_id, wo.mileage_in as km
    from public.work_orders wo
  union all
  select wo.vehicle_id, d.final_mileage as km
    from public.work_order_deliveries d
    join public.work_orders wo on wo.id = d.work_order_id
  union all
  select wo.vehicle_id, l.mileage as km
    from public.work_order_logs l
    join public.work_orders wo on wo.id = l.work_order_id
)
select v.id as vehicle_id,
       v.shop_id,
       s.km
  from public.vehicles v
  join km_sources s on s.vehicle_id = v.id
 where coalesce(v.mileage, 0) = 0
   and v.deleted_at is null
   and s.km is not null
   and s.km > 0;

-- max(km) por vehículo candidato, EXCLUYENDO fuentes >= 1.000.000 km: ningún
-- auto de taller llega al millón, así que eso es un error de tipeo (típicamente
-- texto libre de Zoho en work_order_logs.mileage) y, usado como piso duro en el
-- FE, bloquearía el vehículo en recepción.
create temp table _mileage_backfill on commit drop as
select s.vehicle_id,
       s.shop_id,
       max(s.km) as km
  from _mileage_sources s
 where s.km < 1000000
 group by s.vehicle_id, s.shop_id;

-- Reporte 1: total de vehículos que se van a actualizar (ya sin atípicos).
select count(*) as vehiculos_a_actualizar
  from _mileage_backfill;

-- Reporte 2: desglose por taller.
select sh.name    as taller,
       count(*)   as vehiculos,
       min(b.km)  as km_min,
       max(b.km)  as km_max
  from _mileage_backfill b
  join public.shops sh on sh.id = b.shop_id
 group by sh.name
 order by vehiculos desc;

-- Reporte 3: vehículos sin km que NO se pueden rellenar (ninguna orden con km).
select sh.name  as taller,
       count(*) as vehiculos_sin_fuente
  from public.vehicles v
  join public.shops sh on sh.id = v.shop_id
 where coalesce(v.mileage, 0) = 0
   and v.deleted_at is null
   and not exists (select 1 from _mileage_backfill b where b.vehicle_id = v.id)
 group by sh.name
 order by vehiculos_sin_fuente desc;

-- Reporte 4: ATÍPICOS EXCLUIDOS — vehículos con alguna fuente >= 1.000.000 km
-- (descartada por el tope). Revisar a mano. `km_usado` es lo que se va a
-- cargar desde las otras fuentes (NULL = ese vehículo queda sin rellenar).
select sh.name     as taller,
       v.plate     as placa,
       max(s.km)   as km_descartado,
       b.km        as km_usado
  from _mileage_sources s
  join public.vehicles v on v.id = s.vehicle_id
  join public.shops sh on sh.id = s.shop_id
  left join _mileage_backfill b on b.vehicle_id = s.vehicle_id
 group by sh.name, v.plate, s.vehicle_id, b.km
having max(s.km) >= 1000000
 order by sh.name, max(s.km) desc;

-- Reporte 5: SOSPECHOSOS — candidatos cuyo km elegido supera en más de 3x el
-- mileage_in de la orden más reciente (por created_at) que tiene km. NO se
-- excluyen del backfill; solo se listan para que el operador los revise.
select sh.name           as taller,
       v.plate           as placa,
       b.km              as km_elegido,
       rec.mileage_in    as km_reciente
  from _mileage_backfill b
  join public.vehicles v on v.id = b.vehicle_id
  join public.shops sh on sh.id = b.shop_id
  cross join lateral (
    select wo.mileage_in
      from public.work_orders wo
     where wo.vehicle_id = b.vehicle_id
       and wo.mileage_in > 0
     order by wo.created_at desc, wo.id desc
     limit 1
  ) rec
 where b.km::bigint > 3 * rec.mileage_in::bigint
 order by sh.name, b.km desc;

-- Aplicación. Se re-chequea coalesce(mileage,0)=0 por si algo cambió entre el
-- cálculo y el update (nunca pisar un km cargado).
do $$
declare
  n bigint;
  r record;
begin
  for r in
    select sh.name as taller, count(*) as cnt, min(b.km) as km_min, max(b.km) as km_max
      from _mileage_backfill b
      join public.shops sh on sh.id = b.shop_id
     group by sh.name
     order by count(*) desc
  loop
    raise notice 'taller %: % vehículos (km % .. %)', r.taller, r.cnt, r.km_min, r.km_max;
  end loop;

  update public.vehicles v
     set mileage = b.km
    from _mileage_backfill b
   where v.id = b.vehicle_id
     and coalesce(v.mileage, 0) = 0;
  get diagnostics n = row_count;
  raise notice 'backfill_vehicle_mileage: % vehículos actualizados', n;
end
$$;

-- DRY-RUN: cambiar por `commit;` para aplicar.
rollback;

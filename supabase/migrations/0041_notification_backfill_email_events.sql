-- =============================================================================
-- 0041_notification_backfill_email_events.sql
-- ⛔ MIGRACIÓN DE CONTENCIÓN. Sin esto, deployar el lote L2 le manda correos
-- reales a ~1.300 clientes de golpe.
--
-- POR QUÉ
-- `notification-dispatch` barre con `sweep()` **state-driven y SIN ventana
-- temporal**: cada minuto mira el estado ACTUAL de las tablas y encola lo que no
-- tenga fila en `notification_log`. El dedupe es el índice único de 0034
-- (related_entity_type, related_entity_id, template, channel).
--
-- El lote L2 estrena DOS pares (plantilla, canal):
--     ('work_in_process',    'email')
--     ('delivery_completed', 'email')
-- Para esos pares NO existe ni una fila en el histórico. El primer tick después
-- del deploy los vería "faltantes" en TODAS las órdenes que hoy cumplen la
-- condición del barrido — incluidas las ~1.300 órdenes migradas de Zoho, cuyos
-- vehículos se entregaron hace meses. AMBOS CANALES ESTÁN EN VIVO EN PROD: eso
-- no es un dry-run, son correos reales a clientes reales de 18 talleres.
--
-- QUÉ HACE
-- Siembra esas filas ya en estado TERMINAL (`status='sent'`, `attempts=0`) para
-- que el upsert `ignoreDuplicates` del barrido las respete y no encole nada. Es
-- exactamente la misma palanca que usa el import de Zoho
-- (AntawaTec-FE/scripts/zoho/lib/notifications.mjs). El `payload` deja dicho que
-- la fila es sembrada y que NUNCA se envió, para que nadie lea el log como
-- evidencia de entrega.
--
-- Qué condición espeja cada bloque (leído de sweep(), no de la documentación):
--   work_in_process     → status = 'in_process'   … MÁS 'delivery' e 'historical'
--   delivery_completed  → status = 'historical'
--
-- El barrido de `work_in_process` mira SOLO 'in_process' (es un estado
-- transitorio), pero el backfill cubre además 'delivery' e 'historical': una
-- orden que hoy está entregada YA PASÓ por "en proceso" y podría volver a ese
-- estado por una corrección manual, y ahí el aviso saldría meses tarde. Sembrar
-- de más es gratis (una fila); sembrar de menos es un correo real.
--
-- Los pares que YA existen NO se tocan:
--   ('vehicle_received','email') lo viene encolando el barrido desde 2026-08 —
--   todas las órdenes históricas ya tienen su fila y el dedupe las protege. Lo
--   único que cambia para ellas es que el correo NUEVO lleva PDF adjunto.
--
-- SEGURIDAD DE LA MIGRACIÓN
--   * Es puramente ADITIVA sobre notification_log; no borra ni actualiza nada.
--   * `on conflict ... do nothing` la hace re-ejecutable (y compatible con que
--     el barrido haya alcanzado a encolar algo entre el push y el deploy).
--   * Referencia el valor de enum agregado en 0040, que es OTRO archivo (otra
--     transacción): por eso son dos migraciones y no una.
--
-- ⚠️ ORDEN DE DEPLOY (ver docs/order-emails-deploy.md, que es el runbook):
-- pausar el cron → `db push` (0040 + 0041) → VERIFICAR conteos → recién ahí
-- `functions deploy notification-dispatch` → reanudar el cron. Deployar la
-- función antes del push es el único camino que dispara el blast.
--
-- CÓMO VERIFICAR (antes y después del push)
--   -- 1) Cuántas filas debería sembrar cada bloque:
--   select count(*) filter (where status in ('in_process','delivery','historical')) as work_in_process,
--          count(*) filter (where status = 'historical')                            as delivery_completed
--     from public.work_orders;
--   -- 2) Cuántas quedaron sembradas (tiene que coincidir con lo de arriba):
--   select template, count(*)
--     from public.notification_log
--    where channel = 'email' and payload->>'migration' = '0041'
--    group by 1;
--   -- 3) Control final: NADA en 'queued' para los pares nuevos.
--   select template, channel, status, count(*)
--     from public.notification_log
--    where template in ('work_in_process','delivery_completed')
--    group by 1,2,3 order by 1,2,3;
-- =============================================================================

-- ---------- work_in_process (email) ------------------------------------------
insert into public.notification_log (
  shop_id, customer_id, channel, template,
  related_entity_type, related_entity_id,
  payload, status, attempts, sent_at
)
select
  w.shop_id,
  w.customer_id,
  'email'::public.notification_channel,
  'work_in_process'::public.notification_template,
  'work_order',
  w.id,
  jsonb_build_object(
    'backfill', true,
    'migration', '0041',
    'note', 'sembrada por 0041 (evento anterior al lanzamiento del correo); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(w.updated_at, w.created_at, now())
from public.work_orders w
where w.status in ('in_process', 'delivery', 'historical')
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

-- ---------- delivery_completed (email) ---------------------------------------
-- LEFT JOIN, no INNER: una orden cerrada con el "cierre rápido" del FE puede no
-- tener fila de entrega (o tenerla con delivered_at NULL). Con INNER esas
-- órdenes quedarían SIN sembrar y el primer tick les mandaría el recibo.
insert into public.notification_log (
  shop_id, customer_id, channel, template,
  related_entity_type, related_entity_id,
  payload, status, attempts, sent_at
)
select
  w.shop_id,
  w.customer_id,
  'email'::public.notification_channel,
  'delivery_completed'::public.notification_template,
  'work_order',
  w.id,
  jsonb_build_object(
    'backfill', true,
    'migration', '0041',
    'note', 'sembrada por 0041 (evento anterior al lanzamiento del correo); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(d.delivered_at, w.updated_at, w.created_at, now())
from public.work_orders w
left join public.work_order_deliveries d on d.work_order_id = w.id
where w.status = 'historical'
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

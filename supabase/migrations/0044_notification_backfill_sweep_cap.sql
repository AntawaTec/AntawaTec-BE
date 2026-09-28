-- =============================================================================
-- 0044_notification_backfill_sweep_cap.sql
-- ⛔ MIGRACIÓN DE CONTENCIÓN. Sin esto, deployar el barrido paginado le manda
-- ~290 avisos VIEJOS (WhatsApp y correo reales) a clientes de órdenes que se
-- entregaron hace meses, todos en el primer tick.
--
-- POR QUÉ
-- PostgREST corta toda respuesta en `max_rows = 1000` (supabase/config.toml)
-- SIN error ni aviso. `sweep()` de `notification-dispatch` leía `work_orders`
-- con un `.select()` sin `.range()`, sin `.order()` y sin mirar `error`
-- (`const { data } = …`). Tras el import de Zoho hay ~1.376 órdenes: vuelven
-- 1.000 en orden de heap y TODO lo creado o movido desde el 2026-09-22 quedaba
-- afuera en cada tick. Resultado: 5 días sin `vehicle_received` (wa+email),
-- `vehicle_ready` (wa) ni `delivery_completed` (wa+email) para las órdenes
-- nuevas. (`work_in_process` se salvó: su query filtra `status = 'in_process'`
-- y son ~20 filas.)
--
-- El fix (misma PR: `_shared/paginate.ts` + `notification-dispatch`) pagina con
-- `.order("id")` + `.range()`, lanza si PostgREST devuelve error, y acota el
-- barrido a `updated_at >= now() - 30 días`. Para el dedupe, que el barrido
-- pase a VER filas que antes no veía es lo mismo que estrenar un par
-- (plantilla, canal): al 2026-09-27 hay 296 pares faltantes en 87 órdenes —
-- 256 de 73 órdenes importadas de Zoho (61 DC LABORATORIO, 12 GreenWash;
-- entregadas hace meses) y 40 de 14 órdenes reales del 22 al 27-sep. La
-- ventana de 30 días NO las protege: el importador no escribe `updated_at`, así
-- que las importadas tienen `updated_at` = fecha del import y caen adentro
-- hasta ~2026-10-22.
--
-- QUÉ HACE
-- Siembra las filas faltantes ya en estado TERMINAL (`status='sent'`,
-- `attempts=0`) para que el upsert `ignoreDuplicates` del barrido las respete y
-- no encole nada. Es la misma palanca que 0041 y que el import de Zoho
-- (AntawaTec-FE/scripts/zoho/lib/notifications.mjs). El `payload` deja dicho que
-- la fila es sembrada y que NUNCA se envió: `sent_at` no es evidencia de entrega.
--
-- Matriz (espeja las condiciones de sweep(), leídas del código):
--   vehicle_received    whatsapp + email   TODAS las órdenes
--   vehicle_ready       whatsapp           'historical', y 'delivery' creadas ANTES del cutoff
--   work_in_process     email              'in_process','delivery','historical' (= 0041, casi todo no-op)
--   delivery_completed  whatsapp + email   'historical' (LEFT JOIN a la entrega, como 0041)
-- Cutoff: `timestamptz '2026-09-22 00:00:00-05'` (medianoche hora Ecuador), el
-- primer día sin avisos de la orden.
--
-- ⚠️ LA EXCEPCIÓN DELIBERADA (decisión cerrada del producto, no un olvido)
-- Las órdenes en `delivery` creadas DESDE el cutoff NO se siembran para
-- `vehicle_ready`: son clientes que hoy siguen esperando retirar el vehículo y
-- nunca se enteraron de que está listo. Es el ÚNICO envío retroactivo
-- permitido: el primer tick de la función nueva les manda el "tu vehículo está
-- listo" por WhatsApp. Al 2026-09-27 son 6: #12 y #13 (Betel), #631, #633 y
-- #635 (GreenWash), #63 (Pupiales). Todo lo demás que quedó atrasado (las
-- recepciones de las órdenes nuevas, los recibos de #634 y #657 y las 256 filas
-- de las importadas) se siembra: llega tarde y no le sirve al cliente. El corte
-- es por `created_at`: no hay un registro estructurado de CUÁNDO la orden pasó
-- a `delivery`.
--
-- POR QUÉ NO SE SIEMBRAN appointments NI quotes
-- Sus queries del barrido tienen la misma bomba latente, pero hoy están bajo el
-- tope (365 citas, 38 cotizaciones) y se verificó 0 huecos: el paginado no les
-- agrega ninguna fila y la ventana por `updated_at` solo ACHICA lo que ven. No
-- hay nada que contener, y una migración = un concern. La guardia 0c del
-- runbook lo re-verifica antes del push.
--
-- SEGURIDAD DE LA MIGRACIÓN
--   * Es puramente ADITIVA sobre notification_log; no borra ni actualiza nada.
--   * `on conflict ... do nothing` la hace re-ejecutable y respeta cualquier
--     fila real que ya exista (enviada, fallida o en cola).
--   * Solo usa valores de enum que ya existen (el último, `work_in_process`,
--     llegó en 0040).
--   * En un `db reset` (CI) no hay órdenes: los cuatro inserts son no-op.
--
-- ⚠️ ORDEN DE DEPLOY (ver docs/sweep-pagination-deploy.md, que es el runbook):
-- pausar el cron → `db push` (0044) → VERIFICAR (3 == 0a) → recién ahí
-- `functions deploy notification-dispatch` → tick manual → reanudar el cron.
-- Deployar la función antes del push es el único camino que dispara el blast.
-- Correrlo FUERA del horario de los talleres: una orden creada minutos antes
-- del push queda sembrada y pierde su `vehicle_received`.
-- Si 0b muestra una orden en `delivery` creada cerca de la medianoche del
-- 21/22-sep, ajustar el cutoff ANTES del push: después este archivo es inmutable.
--
-- CÓMO VERIFICAR
--   -- 0a) ANTES del push: cuántas filas debería sembrar cada bloque (≈ 290 al
--   --     2026-09-27; algo más en work_in_process, que se siembra de más).
--   with cand as (
--     select w.id, 'vehicle_received' t, c.ch from public.work_orders w cross join (values ('whatsapp'),('email')) c(ch)
--     union all select w.id, 'vehicle_ready', 'whatsapp' from public.work_orders w
--       where w.status = 'historical' or (w.status = 'delivery' and w.created_at < timestamptz '2026-09-22 00:00:00-05')
--     union all select w.id, 'work_in_process', 'email' from public.work_orders w where w.status in ('in_process','delivery','historical')
--     union all select w.id, 'delivery_completed', c.ch from public.work_orders w cross join (values ('whatsapp'),('email')) c(ch) where w.status = 'historical')
--   select c.t as template, c.ch as channel, count(*) as esperado from cand c
--     left join public.notification_log n on n.related_entity_type = 'work_order' and n.related_entity_id = c.id
--      and n.template::text = c.t and n.channel::text = c.ch
--    where n.id is null group by 1,2 order by 1,2;
--   -- 0b) Las ÚNICAS órdenes que recibirán `vehicle_ready` tarde (6 al 2026-09-27):
--   select order_number, shop_id, status, created_at from public.work_orders
--    where status = 'delivery' and created_at >= timestamptz '2026-09-22 00:00:00-05' order by created_at;
--   -- 3) DESPUÉS del push: sembrado == esperado (0a) por (template, channel)…
--   select template, channel, count(*) sembrado from public.notification_log
--    where payload->>'migration' = '0044' group by 1,2 order by 1,2;
--   -- …y nada 'queued' nuevo (tiene que volver vacío):
--   select template, channel, count(*) from public.notification_log
--    where status = 'queued' and created_at > now() - interval '10 minutes' group by 1,2;
-- =============================================================================

-- ---------- vehicle_received (whatsapp + email) ------------------------------
-- TODAS las órdenes, igual que el barrido. Incluye las creadas desde el cutoff:
-- su "recibimos tu vehículo" ya llega tarde y no se manda.
insert into public.notification_log (
  shop_id, customer_id, channel, template,
  related_entity_type, related_entity_id,
  payload, status, attempts, sent_at
)
select
  w.shop_id,
  w.customer_id,
  c.channel,
  'vehicle_received'::public.notification_template,
  'work_order',
  w.id,
  jsonb_build_object(
    'backfill', true,
    'migration', '0044',
    'note', 'sembrada por 0044 (evento fuera de la ventana de max_rows del barrido); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(w.created_at, w.updated_at, now())
from public.work_orders w
cross join (values ('whatsapp'::public.notification_channel), ('email'::public.notification_channel)) as c(channel)
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

-- ---------- vehicle_ready (whatsapp) -----------------------------------------
-- El barrido lo encola para 'delivery' e 'historical'. Acá quedan AFUERA, a
-- propósito, las órdenes en 'delivery' creadas desde el cutoff: es la excepción
-- de la cabecera (el "tu vehículo está listo" tardío que SÍ se manda).
insert into public.notification_log (
  shop_id, customer_id, channel, template,
  related_entity_type, related_entity_id,
  payload, status, attempts, sent_at
)
select
  w.shop_id,
  w.customer_id,
  'whatsapp'::public.notification_channel,
  'vehicle_ready'::public.notification_template,
  'work_order',
  w.id,
  jsonb_build_object(
    'backfill', true,
    'migration', '0044',
    'note', 'sembrada por 0044 (evento fuera de la ventana de max_rows del barrido); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(w.updated_at, w.created_at, now())
from public.work_orders w
where w.status = 'historical'
   or (w.status = 'delivery' and w.created_at < timestamptz '2026-09-22 00:00:00-05')
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

-- ---------- work_in_process (email) ------------------------------------------
-- Misma condición que 0041 (in_process MÁS delivery e historical: la que ya
-- pasó por "en proceso" podría volver ahí por una corrección manual). Casi todo
-- es no-op: el barrido de este par nunca estuvo truncado (~20 filas).
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
    'migration', '0044',
    'note', 'sembrada por 0044 (evento fuera de la ventana de max_rows del barrido); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(w.updated_at, w.created_at, now())
from public.work_orders w
where w.status in ('in_process', 'delivery', 'historical')
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

-- ---------- delivery_completed (whatsapp + email) ----------------------------
-- LEFT JOIN, no INNER (misma razón que 0041): una orden cerrada con el "cierre
-- rápido" del FE puede no tener fila de entrega, y con INNER quedaría SIN
-- sembrar y el primer tick le mandaría el recibo.
insert into public.notification_log (
  shop_id, customer_id, channel, template,
  related_entity_type, related_entity_id,
  payload, status, attempts, sent_at
)
select
  w.shop_id,
  w.customer_id,
  c.channel,
  'delivery_completed'::public.notification_template,
  'work_order',
  w.id,
  jsonb_build_object(
    'backfill', true,
    'migration', '0044',
    'note', 'sembrada por 0044 (evento fuera de la ventana de max_rows del barrido); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(d.delivered_at, w.updated_at, w.created_at, now())
from public.work_orders w
left join public.work_order_deliveries d on d.work_order_id = w.id
cross join (values ('whatsapp'::public.notification_channel), ('email'::public.notification_channel)) as c(channel)
where w.status = 'historical'
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

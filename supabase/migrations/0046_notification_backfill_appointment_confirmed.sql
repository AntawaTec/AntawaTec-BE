-- =============================================================================
-- 0046_notification_backfill_appointment_confirmed.sql
-- ⛔ MIGRACIÓN DE CONTENCIÓN. Sin esto, deployar el barrido nuevo le manda un
-- "tu cita quedó confirmada" por WhatsApp a TODAS las citas futuras que ya
-- existen (agendadas a mano hace días o semanas; al 2026-10-06 hay decenas,
-- varias para noviembre).
--
-- POR QUÉ
-- `appointment_confirmed` se encolaba SOLO para citas `source = 'quote'`. El
-- lote lo extiende a toda cita activa y futura (walk_in y follow_up incluidas).
-- El barrido es state-driven: el primer tick vería "faltante" el par
-- ('appointment_confirmed','whatsapp') en cada cita manual que hoy cumple la
-- condición (activa, futura, tocada en los últimos 30 días) y la confirmaría
-- con días de atraso. Mismo mecanismo que 0041/0044.
--
-- QUÉ HACE
-- Siembra la fila ya en estado TERMINAL (`status='sent'`, `attempts=0`) para
-- toda cita que existe al momento del push, de cualquier origen y estado: el
-- upsert `ignoreDuplicates` del barrido la respeta y no encola nada. El payload
-- deja dicho que es sembrada y que NUNCA se envió. Las citas de cotización ya
-- tienen su fila real y el `on conflict` las deja intactas.
--
-- `appointment_reminder_today` (0045) NO se siembra: sus condiciones del barrido
-- (cita de HOY que aún no pasó, creada antes de las 07:00) acotan el "backlog" a
-- las citas que quedan del día del deploy, y a esas sí les sirve el aviso.
--
-- SEGURIDAD
--   * Aditiva sobre notification_log; no borra ni actualiza nada.
--   * `on conflict ... do nothing` → re-ejecutable.
--   * Solo usa valores de enum preexistentes (appointment_confirmed es de 0023).
--   * En `db reset` (CI) no hay citas: no-op.
--
-- ⚠️ ORDEN DE DEPLOY (ver docs/appointment-reminders-deploy.md): pausar el cron
-- → `db push` (0045 + 0046) → VERIFICAR → `functions deploy notification-dispatch`
-- → reanudar. Una cita creada entre el push y el deploy queda sembrada y pierde
-- su confirmación: hacerlo fuera del horario de los talleres.
--
-- CÓMO VERIFICAR
--   -- 1) cuántas debería sembrar (citas sin fila de confirmación):
--   select count(*) from public.appointments a
--    where not exists (select 1 from public.notification_log n
--                       where n.related_entity_type = 'appointment' and n.related_entity_id = a.id
--                         and n.template = 'appointment_confirmed' and n.channel = 'whatsapp');
--   -- 2) cuántas sembró (tiene que coincidir):
--   select count(*) from public.notification_log where payload->>'migration' = '0046';
--   -- 3) control: nada 'queued' para appointment_confirmed.
-- =============================================================================

insert into public.notification_log (
  shop_id, customer_id, channel, template,
  related_entity_type, related_entity_id,
  payload, status, attempts, sent_at
)
select
  a.shop_id,
  a.customer_id,
  'whatsapp'::public.notification_channel,
  'appointment_confirmed'::public.notification_template,
  'appointment',
  a.id,
  jsonb_build_object(
    'backfill', true,
    'migration', '0046',
    'note', 'sembrada por 0046 (cita anterior a la confirmación de citas manuales); nunca se envió'
  ),
  'sent'::public.notification_status,
  0,
  coalesce(a.updated_at, a.created_at, now())
from public.appointments a
on conflict (related_entity_type, related_entity_id, template, channel) do nothing;

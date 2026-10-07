-- =============================================================================
-- 0045_notification_template_appointment_reminder_today.sql
-- Octavo valor del enum `notification_template`: `appointment_reminder_today`.
--
-- Recordatorio el DÍA de la cita, a las 07:00 de Ecuador (pedido del taller,
-- 2026-10-06). Complementa al de 24 h: una cita agendada con menos de un día de
-- anticipación nunca entra en esa ventana y hoy se queda sin recordatorio.
-- WhatsApp-only (plantilla nueva en Twilio: ver docs/appointment-reminders-deploy.md).
--
-- ⚠️ MIGRACIÓN DE UNA SOLA LÍNEA A PROPÓSITO (convención del repo, ver 0040):
-- Postgres no deja USAR un valor de enum en la misma transacción que lo agrega.
-- La contención del lote vive en 0046 (otro archivo = otra transacción).
-- =============================================================================

alter type public.notification_template add value if not exists 'appointment_reminder_today';

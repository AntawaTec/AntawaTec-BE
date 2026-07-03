-- =============================================================================
-- 0016_appointment_source_follow_up.sql
-- Agrega 'follow_up' al enum appointment_source (quote | walk_in | follow_up).
-- El FE ya tiene un botón "cita de seguimiento" que hoy cae a 'walk_in' por falta
-- de un valor propio; este valor la distingue.
--
-- AISLADO A PROPÓSITO — NO agregar nada más a este archivo: `ALTER TYPE ... ADD
-- VALUE` no puede usarse en la misma transacción que luego REFERENCIA el valor
-- nuevo, y Supabase envuelve cada archivo de migración en una transacción. Mantener
-- una sola sentencia aquí evita ese caveat. Las citas existentes no se afectan
-- (solo se amplía el dominio del enum). Un futuro uso de 'follow_up' debe ir en una
-- migración numerada DESPUÉS de esta.
-- =============================================================================

alter type public.appointment_source add value if not exists 'follow_up';

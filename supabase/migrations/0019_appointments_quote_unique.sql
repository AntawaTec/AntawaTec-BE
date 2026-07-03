-- =============================================================================
-- 0019_appointments_quote_unique.sql
-- Backstop 1:1 cita <-> cotización (appointments.quote_id único). Hardening del
-- flujo de aprobación de cotización (TODO de quotes.ts:295): una cotización aprobada
-- debe generar EXACTAMENTE una cita. Separado de 0018 a propósito — es otro concern
-- y es el único cambio con riesgo sobre datos existentes.
--
-- Único PARCIAL (where quote_id is not null): la mayoría de las citas son walk-in /
-- seguimiento con quote_id NULL, y esas no deben colisionar entre sí.
--
-- ⚠️ PRE-CHECK ANTES DE APLICAR: este índice falla si ya existen 2+ citas con el
-- mismo quote_id. Verificar en remoto primero (read-only):
--   select quote_id, count(*)
--     from public.appointments
--    where quote_id is not null
--    group by quote_id having count(*) > 1;
-- 0 filas => entra limpio. Si hay filas => deduplicar (decisión de datos: cuál cita
-- se conserva) ANTES de pushear esta migración.
-- =============================================================================

create unique index appointments_quote_id_key
  on public.appointments (quote_id) where quote_id is not null;

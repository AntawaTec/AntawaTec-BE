-- =============================================================================
-- 0017_appointment_reason.sql
-- Motivo estandarizado de la cita (appointments.reason).
--
-- Por qué: las citas que vienen de una cotización ya muestran su motivo (los tipos
-- de sección maintenance/bodywork derivados del quote). Las walk_in / follow_up no
-- tienen de dónde derivarlo. Esta columna les da un motivo estandarizado, elegido
-- de una lista CURADA EN EL FE; la nota libre (`notes`) sigue siendo el detalle.
--
-- Texto libre, SIN enum: la lista de motivos la cura el FE, así se agregan motivos
-- nuevos sin requerir una migración. (Si más adelante se quiere un set cerrado o
-- reportería por motivo, es una migración aditiva limpia — mismo criterio que
-- products.category en 0015.)
--
-- SIN cambios de RLS: appointments ya es shop-scoped (apply_tenant_rls en 0006);
-- reason es un atributo más cubierto por las policies existentes.
-- =============================================================================

alter table public.appointments add column if not exists reason text;

-- =============================================================================
-- 0036_subscription_provider_payphone.sql
-- Agrega 'payphone' al enum subscription_provider (hotmart | bank_transfer |
-- payphone). Es el tercer camino del embudo: pago con tarjeta desde la landing
-- vía el Botón de Pago por redirección de Payphone. `provisionTenant` ya es
-- provider-agnóstico (escribe subscriptions.provider), así que el enum es lo
-- único que hay que ampliar para que el proveedor exista en la plataforma.
--
-- AISLADO A PROPÓSITO — NO agregar nada más a este archivo: `ALTER TYPE ... ADD
-- VALUE` no puede usarse en la misma transacción que luego REFERENCIA el valor
-- nuevo, y Supabase envuelve cada archivo de migración en una transacción. La
-- tabla card_payment_intents, que usa 'payphone' como DEFAULT, va en 0037.
-- =============================================================================

alter type public.subscription_provider add value if not exists 'payphone';

-- =============================================================================
-- 0011_provisioning_hardening.sql
-- Blinda la idempotencia del provisioning a nivel de DB. provisionTenant() ya
-- comprueba-antes-de-crear, pero dos webhooks en carrera podían colar duplicados.
-- Estas UNIQUE constraints cierran la ventana de raíz. Nombres EXPLÍCITOS para
-- que el código distinga qué constraint se violó al manejar el error 23505
-- (en vez de depender del formato del mensaje de PostgREST).
--   - shops_contact_email_unique: en V1, un email de dueño = un taller.
--     contact_email es nullable; Postgres permite múltiples NULL en un unique,
--     así que las filas sin email no se ven afectadas.
--   - subscriptions_shop_provider_unique: una subscription por (taller, proveedor).
-- Verificado contra scripts/seed.sql: los datos demo no violan ninguna.
-- =============================================================================

alter table public.shops
  add constraint shops_contact_email_unique unique (contact_email);

alter table public.subscriptions
  add constraint subscriptions_shop_provider_unique unique (shop_id, provider);

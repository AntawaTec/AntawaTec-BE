-- =============================================================================
-- 0024_notification_cron.sql
-- Scheduling del pipeline: pg_cron invoca la edge function notification-dispatch
-- cada minuto (barre + drena). pg_net hace el POST HTTP desde la DB.
--
-- La URL y el secret se leen de SETTINGS de la DB, configurables por entorno
-- (local / staging / prod) sin tocar esta migración:
--   alter database postgres set app.notification_dispatch_url = 'https://<ref>.functions.supabase.co/notification-dispatch';
--   alter database postgres set app.cron_secret = '<CRON_SECRET de la función>';
-- Si no están seteados, el job es NO-OP (no falla) — así el core (barrido+drenado)
-- funciona por invocación manual/test mientras el scheduling se configura aparte.
-- (El cron es la pata más env-specific del pipeline; el resto se prueba sin él.)
-- =============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'notification-dispatch',
  '* * * * *',
  $$
    select net.http_post(
      url     := current_setting('app.notification_dispatch_url', true),
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', current_setting('app.cron_secret', true)
      ),
      body    := '{}'::jsonb
    )
    where current_setting('app.notification_dispatch_url', true) is not null
      and current_setting('app.notification_dispatch_url', true) <> '';
  $$
);

-- =============================================================================
-- 0053_invoice_reconcile_cron.sql
-- Cron de `invoice-reconcile` cada 5 minutos: resuelve las facturas que quedaron
-- en 'processing' (la emisión no tuvo respuesta definitiva del proveedor, o el
-- webhook no llegó). Solo mira filas 'processing' de más de 2 minutos; no barre
-- histórico, así que NO aplica la siembra de filas terminales de 0041/0044.
--
-- Mismo patrón que 0024 / 0048: URL y secret por SETTINGS de la DB, y NO-OP si
-- la URL no está seteada (local / staging sin configurar):
--   alter database postgres set app.invoice_reconcile_url = 'https://<ref>.supabase.co/functions/v1/invoice-reconcile';
--   alter database postgres set app.cron_secret = '<CRON_SECRET de la función>';
-- En prod `app.cron_secret` no existe: el comando se reescribe con URL y secret
-- literales vía cron.alter_job (ver docs/billing-deploy.md).
--
-- A diferencia de notification-dispatch, invoice-reconcile RECHAZA la llamada si
-- CRON_SECRET no está configurado en la función: el job sin secret es inútil.
-- =============================================================================
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'invoice-reconcile',
  '*/5 * * * *',
  $$
    select net.http_post(
      url     := current_setting('app.invoice_reconcile_url', true),
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', current_setting('app.cron_secret', true)
      ),
      body    := '{}'::jsonb
    )
    where current_setting('app.invoice_reconcile_url', true) is not null
      and current_setting('app.invoice_reconcile_url', true) <> '';
  $$
);

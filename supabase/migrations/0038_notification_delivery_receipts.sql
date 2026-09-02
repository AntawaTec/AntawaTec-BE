-- =============================================================================
-- 0038_notification_delivery_receipts.sql
-- Recibos de entrega de WhatsApp (webhooks de Meta).
--
-- Hasta hoy `notification_log.status = 'sent'` significaba SOLO "la Cloud API
-- devolvió 200", no "el cliente lo recibió": los webhooks de la WABA estaban en
-- OFF, así que la única forma de ver entregas era Meta Business Manager a mano.
-- Esta migración agrega las columnas donde `whatsapp-webhook` deja los recibos.
--
-- `provider_message_id` es el wamid que devuelve la Cloud API al aceptar el
-- mensaje; es la ÚNICA llave con la que el webhook puede encontrar la fila
-- (Meta no conoce nuestros uuid).
--
-- DECISIÓN IMPORTANTE: una entrega fallida NO toca `status`. El drenado de
-- notification-dispatch reencola `status='failed' and attempts < 5`, así que
-- marcar 'failed' desde el webhook dispararía un REENVÍO — el mensaje ya salió
-- y Meta ya lo cobró. El fallo de entrega vive en `provider_status`/`error`.
-- =============================================================================

alter table public.notification_log
  add column if not exists provider_message_id text,
  add column if not exists provider_status     text,
  add column if not exists delivered_at        timestamptz,
  add column if not exists read_at             timestamptz;

comment on column public.notification_log.provider_message_id is
  'wamid devuelto por la WhatsApp Cloud API al aceptar el mensaje. Llave de correlación del webhook de estados.';
comment on column public.notification_log.provider_status is
  'Último estado reportado por Meta: sent | delivered | read | failed. Independiente de `status` (que es el estado de NUESTRO envío).';

-- Índice parcial: el webhook busca siempre por wamid no-nulo, y las filas de
-- email / dry-run nunca lo tienen.
create index if not exists notification_log_provider_message_id_idx
  on public.notification_log (provider_message_id)
  where provider_message_id is not null;

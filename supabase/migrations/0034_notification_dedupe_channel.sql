-- =============================================================================
-- 0034_notification_dedupe_channel.sql
-- El índice de dedupe del encolado suma `channel` a la clave.
--
-- Por qué: desde este lote un mismo evento se notifica por DOS canales (WhatsApp
-- y email). El índice de 0023 era (related_entity_type, related_entity_id,
-- template) — sin canal —, así que la fila de email COLISIONARÍA con la de
-- WhatsApp del mismo evento y el upsert `ignoreDuplicates: true` del barrido la
-- descartaría EN SILENCIO: el correo nunca se encolaría y no habría error, ni
-- fila, ni rastro. El modo de falla es invisible; de ahí que el índice se amplíe
-- en la misma tanda que el código.
--
-- La otra mitad de este cambio vive en notification-dispatch/index.ts (el
-- onConflict del upsert pasa a las 4 columnas) y va en el MISMO PR: son las dos
-- caras del mismo contrato. Entre el `db push` y el `functions deploy` hay una
-- ventana en la que el onConflict viejo de 3 columnas no encuentra índice y el
-- barrido responde 500 — inofensiva (el cron reintenta, el barrido es
-- state-driven y no pierde eventos, y el envío sigue en dry-run) pero corta:
-- deployar la función en la MISMA sesión.
--
-- Seguro sobre las filas existentes: todas son channel='whatsapp', así que ya son
-- únicas bajo la cuádrupla por construcción (verificar igual antes de pushear con
-- `select channel, template, status, count(*) from notification_log group by 1,2,3;`).
--
-- No-parcial, igual que 0023: ON CONFLICT (cols) no puede inferir un índice
-- parcial. Se crea el nuevo ANTES de borrar el viejo para no dejar ni un instante
-- sin garantía de dedupe.
-- =============================================================================

create unique index notification_log_event_channel_unique
  on public.notification_log (related_entity_type, related_entity_id, template, channel);

drop index public.notification_log_event_unique;

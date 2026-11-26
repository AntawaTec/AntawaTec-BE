-- =============================================================================
-- 0054_quote_sends.sql
-- Reenvío de una cotización al cliente ("le mando la actualizada").
--
-- Hasta hoy `quote_ready` salía UNA sola vez por cotización: el barrido de
-- notification-dispatch dedupea por (related_entity_type='quote', quote_id,
-- template, channel) y `quotes.sent_at` solo dispara el primer envío. Si el taller
-- agregaba un ítem después de enviarla, no había forma de mandar la versión nueva
-- (pedido de un taller en prod, 2026-11-25).
--
-- Diseño: UNA FILA POR REENVÍO. Cada fila es un evento nuevo para el barrido, que
-- lo encola con related_entity_type = 'quote_send' y related_entity_id = id de
-- esta fila. Así:
--   - El índice de dedupe (0034) NO se toca. Cambiarlo obligaría a deployar DB y
--     función en la misma ventana y, para el dedupe, equivale a estrenar una clave
--     (riesgo de reenviar avisos viejos reales). Acá los pares existentes quedan
--     exactamente como están.
--   - El PRIMER envío sigue igual (quotes.sent_at → 'quote'). Esta tabla es solo
--     para los envíos 2..N, así que no arrastra backlog: nace vacía.
--   - Queda el historial de cuándo y quién reenvió.
--   - Orden de deploy: `db push` ANTES que `functions deploy`. La función vieja
--     ignora la tabla. La nueva sin la tabla no rompe nada (su bloque de reenvíos
--     está aislado y reporta `resend_error`), pero los reenvíos no salen hasta
--     que exista.
--
-- APPEND-ONLY para el dueño: insertar un reenvío dispara mensajes reales, y una
-- fila editada o borrada después no "des-envía" nada. Se quitan las políticas de
-- update/delete que genera apply_tenant_rls. El borrado de la cotización igual
-- limpia sus filas (ON DELETE CASCADE corre como el owner de la tabla, sin RLS).
--
-- Técnicos: sin política (current_shop_id() es NULL para ellos, 0021–0022) →
-- no pueden reenviar. Enviarle la cotización al cliente es decisión del dueño,
-- igual que el primer envío (0033).
-- =============================================================================

create table public.quote_sends (
  id          uuid primary key default gen_random_uuid(),
  shop_id     uuid not null references public.shops(id) on delete cascade,
  quote_id    uuid not null,
  created_by  uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  -- FK COMPUESTO (lección de 0018): la policy de apply_tenant_rls solo mira el
  -- shop_id de la fila propia; sin esto se podría colgar un reenvío de una
  -- cotización de OTRO taller y hacerle llegar un mensaje a un cliente ajeno.
  constraint quote_sends_quote_fk
    foreign key (quote_id, shop_id) references public.quotes (id, shop_id)
    on delete cascade
);

create index quote_sends_quote_id_idx on public.quote_sends (quote_id);
create index quote_sends_shop_id_idx  on public.quote_sends (shop_id);
-- El barrido filtra por ventana de created_at (las filas nunca se actualizan).
create index quote_sends_created_at_idx on public.quote_sends (created_at);

select private.apply_tenant_rls('quote_sends');
drop policy quote_sends_update on public.quote_sends;
drop policy quote_sends_delete on public.quote_sends;

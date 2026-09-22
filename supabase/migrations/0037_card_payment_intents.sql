-- =============================================================================
-- 0037_card_payment_intents.sql
-- Estado del intento de pago con TARJETA (Payphone, Botón de Pago por
-- redirección). Tabla de plataforma, igual que webhook_events: existe ANTES de
-- que exista el taller y solo la escribe el service_role desde Edge Functions.
--
-- POR QUÉ HACE FALTA PERSISTIR EL INTENTO.
-- Payphone devuelve al usuario a `responseUrl?id=<int>&clientTransactionId=<uuid>`
-- y el Confirm server-side responde la transacción, pero NINGUNO de los dos trae
-- el taller ni el plan que el prospecto escribió en la landing. Hay que guardar
-- businessName/email ANTES de redirigir para poder provisionar al volver. El
-- `id` de esta tabla ES el `clientTransactionId` que viaja a Payphone (uuid), así
-- que el retorno se resuelve con una sola lectura por PK.
--
-- MÁQUINA DE ESTADOS (card_payment_status). El único camino feliz es
--   created -> confirming -> confirmed -> approved
--
--   created     payphone-prepare insertó la fila y obtuvo el link de pago.
--               Todavía no hay cobro. Es también el estado al que se VUELVE si
--               el Confirm falla por red/5xx: el usuario puede reintentar
--               dentro de la ventana de 5 min de Payphone.
--   confirming  lock optimista: una invocación de payphone-confirm está
--               llamando al Confirm de Payphone o provisionando. Cualquier otra
--               invocación concurrente (doble clic, dos pestañas) recibe 409 y
--               reintenta. Un `confirming` con updated_at viejo (> 60 s) se
--               considera abandonado y se puede re-adquirir (ver la RPC de abajo).
--   confirmed   EL COBRO YA ES REAL (Confirm devolvió statusCode 3). A partir de
--               acá un fallo NO puede perder el pago: el reintento salta el
--               Confirm (no es idempotente en Payphone) y reintenta SOLO el
--               provisioning.
--   approved    provisioning hecho: hay shop_id y el dueño recibió su magic link.
--               Estado terminal feliz; un reintento responde 200 idempotente.
--   cancelled   Confirm devolvió statusCode 2 (el usuario abandonó el pago).
--               Terminal. No hay cobro.
--   failed      Terminal de error irrecuperable: el Prepare nunca dio link, o el
--               Confirm devolvió una transacción que NO corresponde a este intento
--               (clientTransactionId o monto distintos). Se investiga a mano.
--
-- SIN RLS POLICIES (igual que webhook_events en 0009): RLS activado + cero
-- políticas = solo el service_role (que salta RLS) toca la tabla. Ni el dueño ni
-- el admin la leen desde el navegador en V1.
-- =============================================================================

create type public.card_payment_status as enum (
  'created',
  'confirming',
  'confirmed',
  'approved',
  'cancelled',
  'failed'
);

create table public.card_payment_intents (
  id                      uuid primary key default gen_random_uuid(),  -- = clientTransactionId enviado a Payphone
  provider                public.subscription_provider not null default 'payphone',
  business_name           text not null,
  email                   text not null,
  amount                  numeric(12,2) not null,      -- dinero como numeric (CLAUDE.md); a Payphone va en centavos
  status                  public.card_payment_status not null default 'created',
  payphone_payment_id     text,                        -- paymentId devuelto por el Prepare
  payphone_transaction_id bigint,                      -- id de la transacción devuelto por el Confirm
  authorization_code      text,
  shop_id                 uuid references public.shops(id) on delete set null,
  confirmed_at            timestamptz,                 -- cuándo Payphone confirmó el cobro (statusCode 3)
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

-- Cap anti-abuso de payphone-prepare: N intents 'created' de un email en la última hora.
create index card_payment_intents_email_status_created_idx
  on public.card_payment_intents (email, status, created_at);

-- Nombre EXPLÍCITO para poder distinguir el 23505 desde el código (convención de
-- 0011). Una transacción de Payphone no puede quedar atada a dos intents: si el
-- Confirm devolviera un transactionId ya usado, el insert falla en vez de duplicar
-- el cobro en silencio. Nullable => los intents sin confirmar no colisionan entre sí.
alter table public.card_payment_intents
  add constraint card_payment_intents_payphone_tx_unique unique (payphone_transaction_id);

create trigger set_card_payment_intents_updated_at before update on public.card_payment_intents
  for each row execute function public.set_updated_at();

alter table public.card_payment_intents enable row level security;
-- Sin policies => solo el service_role (salta RLS) escribe/lee esta tabla.

-- =============================================================================
-- Lock optimista atómico del intento.
--
-- payphone-confirm puede ser invocada varias veces en paralelo (el usuario
-- recarga la página de retorno, hace doble clic, o abre dos pestañas). El Confirm
-- de Payphone NO es idempotente, así que exactamente UNA invocación debe poder
-- llamarlo. Un `select` seguido de un `update` desde la Edge Function deja una
-- ventana de carrera; esta función hace la comprobación y la toma del lock en UNA
-- sola sentencia, con `for update` para serializar a las concurrentes.
--
-- Devuelve 0 filas si el intento no existe o si NO se pudo adquirir (está en
-- 'approved' / 'cancelled' / 'failed', o alguien más lo tiene 'confirming' desde
-- hace menos de p_stale_seconds). El caller relee la fila y responde por estado.
--
-- `previous_status` es la clave del diseño: dice de dónde venía el lock, y por
-- tanto si hay que llamar al Confirm de Payphone ('created') o si el cobro ya está
-- hecho y solo falta provisionar ('confirmed'). RETURNING solo ve la fila NUEVA,
-- de ahí el CTE `as materialized`, que captura el estado viejo antes del update.
-- =============================================================================
create or replace function public.acquire_card_payment_intent(
  p_id             uuid,
  p_stale_seconds  integer default 60
)
returns table (
  id                      uuid,
  previous_status         public.card_payment_status,
  business_name           text,
  email                   text,
  amount                  numeric(12,2),
  payphone_payment_id     text,
  payphone_transaction_id bigint,
  authorization_code      text,
  shop_id                 uuid
)
language sql
security definer
set search_path = ''
as $$
  with candidate as materialized (
    select ci.id, ci.status
      from public.card_payment_intents ci
     where ci.id = p_id
       and (
              ci.status in ('created', 'confirmed')
           or (ci.status = 'confirming'
               and ci.updated_at < now() - make_interval(secs => p_stale_seconds))
           )
       for update
  )
  update public.card_payment_intents ci
     set status = 'confirming'
    from candidate c
   where ci.id = c.id
  returning ci.id,
            c.status,
            ci.business_name,
            ci.email,
            ci.amount,
            ci.payphone_payment_id,
            ci.payphone_transaction_id,
            ci.authorization_code,
            ci.shop_id;
$$;

-- Solo el service_role (Edge Functions) la ejecuta. anon y authenticated se
-- revocan EXPLÍCITAMENTE: Supabase les concede EXECUTE sobre las funciones nuevas
-- de `public` por default privileges, así que un `revoke ... from public` NO
-- alcanza (verificado con has_function_privilege). Y esta función es SECURITY
-- DEFINER: sin el revoke, cualquiera con la anon key podría dejar un intento ajeno
-- en 'confirming' y bloquear su confirmación.
revoke execute on function public.acquire_card_payment_intent(uuid, integer)
  from public, anon, authenticated;
grant  execute on function public.acquire_card_payment_intent(uuid, integer)
  to service_role;

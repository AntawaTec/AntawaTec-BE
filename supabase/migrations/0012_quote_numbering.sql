-- =============================================================================
-- 0012_quote_numbering.sql
-- Número de cotización correlativo POR taller (quotes.quote_number).
-- El FE inserta quotes SIN número; el correlativo se asigna server-side por un
-- trigger BEFORE INSERT para evitar condiciones de carrera. El contador vive en
-- una tabla dedicada en el esquema `private` (invisible al rol authenticated por
-- construcción — no se expone vía PostgREST ni aparece en los tipos generados),
-- más fuerte que un revoke que se puede olvidar.
--
-- Concurrencia: el upsert `on conflict (shop_id) do update ... returning` toma un
-- row-lock sobre la fila del contador de ESE taller hasta fin-de-tx, serializando
-- inserts concurrentes del mismo taller sin bloquear a otros. El UNIQUE(shop_id,
-- quote_number) es el backstop: convierte cualquier bug de lógica en un 23505
-- ruidoso en vez de números duplicados silenciosos.
--
-- "Sin huecos" NO es una garantía: un rollback después de incrementar el contador
-- quema un número, y eso es físicamente inevitable sin lógica de compensación. Una
-- cotización/proforma NO es un comprobante fiscal SRI (no hay obligación de
-- secuencial gapless), así que los huecos son aceptables. Si alguna vez se agrega
-- un módulo de facturación con secuencial legal, ESTE diseño se reemplaza por un
-- asignador gapless (reserve-on-commit) — decisión diferida a propósito.
--
-- La columna lleva DEFAULT 0 para que el tipo generado (TablesInsert<"quotes">) la
-- marque OPCIONAL — el FE correctamente NO la envía, y sin el default el tipo Insert
-- la exigiría y saveQuote dejaría de compilar. El 0 es un SENTINELA: el trigger
-- BEFORE INSERT siempre lo reemplaza por el correlativo real antes de persistir, así
-- que un 0 nunca se guarda ni choca con el UNIQUE.
--
-- El trigger es coalesce-aware (NO sobrescribe-siempre): un insert authenticated
-- nunca manda quote_number (llega el DEFAULT 0) => se asigna del contador; un import
-- service_role PUEDE suministrar un número explícito > 0 (p. ej. preservar el número
-- original de Zoho) => se conserva y el contador se adelanta con greatest() para que
-- los próximos auto-números nunca colisionen. La rama es sobre el VALOR (NULL o 0 =
-- "no suministrado"), no sobre la identidad del caller (sin decisión de confianza
-- spoofeable). Los números de cotización son >= 1, así que 0 es un sentinela seguro.
--
-- Orden de operaciones:
--   columna NOT NULL DEFAULT 0 -> backfill -> seed contador -> unique -> trigger.
--   (backfill ANTES del unique: las filas existentes valen 0 transitoriamente, el
--    backfill las hace distintas antes de que exista la constraint.)
-- =============================================================================

-- ---------- Contador por taller (interno; solo lo toca el trigger) -----------
create table private.shop_quote_counters (
  shop_id      uuid primary key references public.shops(id) on delete cascade,
  last_number  int not null default 0
);
-- RLS on + cero policies (consistente con "RLS en TODAS las tablas"). Estando en
-- `private`, authenticated ni siquiera tiene USAGE del esquema: doble candado.
alter table private.shop_quote_counters enable row level security;

-- ---------- Columna (NOT NULL DEFAULT 0; ver nota del sentinela arriba) -------
-- DEFAULT 0 => el tipo Insert generado la marca opcional; el trigger reemplaza el 0.
alter table public.quotes add column quote_number int not null default 0;

-- ---------- Backfill determinista de las quotes existentes -------------------
-- Numera por taller ordenando por created_at; desempata por id para que filas con
-- el mismo created_at queden en un orden estable y reproducible.
with numbered as (
  select id,
         row_number() over (partition by shop_id order by created_at, id) as n
  from public.quotes
)
update public.quotes q
   set quote_number = numbered.n
  from numbered
 where numbered.id = q.id;

-- ---------- Sembrar el contador al máximo por taller -------------------------
-- Los talleres sin quotes no obtienen fila; el trigger la crea perezosamente en
-- el primer insert (values (shop, 1) on conflict => deja last_number = 1).
insert into private.shop_quote_counters (shop_id, last_number)
select shop_id, max(quote_number)
  from public.quotes
 group by shop_id;

-- Backstop con nombre explícito (estilo 0011) para distinguir el 23505 desde el FE.
-- Va DESPUÉS del backfill: las filas existentes ya tienen números distintos por taller.
alter table public.quotes
  add constraint quotes_shop_number_unique unique (shop_id, quote_number);

-- ---------- Trigger de asignación (SECURITY DEFINER, search_path='') ---------
-- Definer para poder tocar private.shop_quote_counters, que el caller no puede.
-- Alias `as c` en el target del INSERT para referenciar la fila existente de forma
-- inequívoca e independiente del search_path en la cláusula ON CONFLICT DO UPDATE.
create or replace function private.assign_quote_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.quote_number is null or new.quote_number = 0 then
    -- Camino normal (authenticated): llega NULL o el DEFAULT 0 => asignar el
    -- siguiente número del taller desde el contador.
    insert into private.shop_quote_counters as c (shop_id, last_number)
    values (new.shop_id, 1)
    on conflict (shop_id) do update
      set last_number = c.last_number + 1
    returning c.last_number into new.quote_number;
  else
    -- Camino import (service_role): conservar el número suministrado y adelantar
    -- el contador para que los próximos auto-números no colisionen.
    insert into private.shop_quote_counters as c (shop_id, last_number)
    values (new.shop_id, new.quote_number)
    on conflict (shop_id) do update
      set last_number = greatest(c.last_number, excluded.last_number);
  end if;
  return new;
end;
$$;

revoke execute on function private.assign_quote_number() from public;

create trigger assign_quote_number
  before insert on public.quotes
  for each row execute function private.assign_quote_number();

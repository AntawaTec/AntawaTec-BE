-- =============================================================================
-- 0042_bank_transfer_renewals.sql
-- Renovación MENSUAL por transferencia: el dueño de un taller ya provisionado
-- sube su comprobante desde la PWA y el admin de Antawa lo aprueba, extendiendo
-- `subscriptions.current_period_end` un mes calendario.
--
-- POR QUÉ acá y no una tabla nueva: `bank_transfer_proofs` ya ES el comprobante
-- de transferencia con su ciclo pending → approved/rejected, su bucket
-- (`payment-proofs`) y su pantalla en el admin. Lo único que le faltaba era
-- distinguir el ALTA (`signup`: prospecto anónimo, sin taller todavía, escribe
-- `bank-transfer-intake` con service_role) de la RENOVACIÓN (`renewal`: dueño
-- autenticado, taller existente, escribe él mismo bajo RLS) y guardar QUÉ
-- período pagó. Duplicar la tabla habría duplicado también el admin.
--
-- Cambios:
--   - enum `bank_transfer_kind` + columna `kind` (default 'signup' → las filas
--     existentes, que son todas altas, quedan correctas sin backfill).
--   - `period_start` / `period_end`: el período que ESTE comprobante pagó. Se
--     escriben en la APROBACIÓN (no en el alta) y son el ancla de idempotencia
--     de la Edge Function `subscription-renewal-approval`: si el approve falla
--     después de marcar el proof, el reintento reusa el `period_end` guardado en
--     vez de volver a sumar un mes. Nunca se suman dos meses por un retry.
--   - `kind='renewal'` exige `shop_id` (un alta todavía no tiene taller; una
--     renovación SIEMPRE lo tiene: es de quien la sube).
--   - Un solo comprobante de renovación `pending` por taller (unique parcial con
--     nombre explícito, convención 0011: el FE traduce el 23505 a "ya tenés un
--     comprobante en revisión").
--
-- Nota sobre `create type` + uso en la MISMA migración: es válido. La
-- restricción de "una migración por valor" de CLAUDE.md aplica a
-- `ALTER TYPE ... ADD VALUE` (que no puede usarse en la tx que lo agrega, ver
-- 0016), no a un tipo nuevo.
--
-- Wart conocido (documentado, no corregido acá): `business_name` y `email` son
-- NOT NULL desde 0009 porque nacieron para el intake anónimo. En una renovación
-- el FE los manda igual con el nombre del taller y el email del dueño — son
-- redundantes con `shop_id` pero quitarles el NOT NULL es una migración aparte
-- con riesgo sobre el intake. La lista del admin los sigue mostrando igual.
-- =============================================================================

create type public.bank_transfer_kind as enum ('signup', 'renewal');

alter table public.bank_transfer_proofs
  add column kind         public.bank_transfer_kind not null default 'signup',
  add column period_start timestamptz,
  add column period_end   timestamptz;

-- Sin fuga de NULL: `kind` es NOT NULL, así que el primer disyunto nunca evalúa
-- a NULL; para 'signup' el CHECK pasa siempre (shop_id se llena al aprobar).
-- Las filas existentes son todas 'signup' por el default → la validación del
-- ALTER no puede fallar.
alter table public.bank_transfer_proofs
  add constraint btp_renewal_requires_shop_ck
  check (kind <> 'renewal' or shop_id is not null);

-- Un comprobante de renovación pendiente por taller: evita que el dueño (o un
-- doble submit) encole tres meses en revisión y que el admin apruebe dos veces
-- el mismo mes. Los 'signup' y los ya resueltos quedan fuera del índice (el
-- intake anónimo conserva su propio cap de 3 pendientes por email, in-code).
create unique index btp_one_pending_renewal_per_shop
  on public.bank_transfer_proofs (shop_id)
  where kind = 'renewal' and status = 'pending';

-- Historial de pagos del taller en el admin y en la PWA ("tus comprobantes").
create index btp_shop_kind_idx on public.bank_transfer_proofs (shop_id, kind);

-- =====================================================================
-- RLS — carve-out ADITIVO del dueño, solo sobre SUS renovaciones.
-- `btp_admin_all` (0009) no se toca: el admin sigue con FOR ALL sobre todo,
-- y las filas de alta ('signup') siguen siendo invisibles para cualquier dueño.
-- =====================================================================

-- El dueño ve el estado de sus propias renovaciones (pending / approved /
-- rejected) para mostrarlo en la PWA. current_shop_id() es NULL para admin y
-- técnicos → la comparación da NULL → no les otorga nada.
create policy btp_owner_select_renewals on public.bank_transfer_proofs
  for select to authenticated
  using (
    kind = 'renewal'
    and shop_id = (select private.current_shop_id())
  );

-- El dueño crea su comprobante. El WITH CHECK fija TODO lo que no le
-- corresponde decidir: no puede auto-aprobarse (`status='pending'`), ni firmar
-- la validación (`validated_*` null), ni inventarse el período pagado
-- (`period_*` null: los escribe la Edge Function al aprobar), ni cargarle la
-- renovación a otro taller, ni colar un 'signup' (que sería invisible para él
-- y entraría al embudo de altas creando un taller duplicado).
create policy btp_owner_insert_renewal on public.bank_transfer_proofs
  for insert to authenticated
  with check (
    kind = 'renewal'
    and shop_id = (select private.current_shop_id())
    and status = 'pending'
    and validated_by is null
    and validated_at is null
    and period_start is null
    and period_end is null
  );

-- SIN update/delete para el dueño, a propósito: un comprobante subido es
-- evidencia, no un borrador. Corregir uno mal cargado es del admin (que lo
-- rechaza y el dueño sube otro). Consecuencia aceptada: si el upload al bucket
-- falla DESPUÉS del insert, la fila queda pendiente hasta que el admin la
-- rechace — el FE sube el archivo PRIMERO y recién después inserta la fila
-- (mismo orden que bank-transfer-intake).

-- =============================================================================
-- 0055_work_order_void.sql
-- Anular / reactivar una orden de trabajo.
--
-- Pedido de un taller en prod (2026-11): duplicó una orden por error y no tenía
-- cómo quitarla — "eliminarla o darla de baja para que me quede en el registro".
-- Decisión de producto: ANULAR, no borrar. La orden queda en el registro (con
-- quién, cuándo y por qué), deja de contar y se puede REACTIVAR si fue un error.
--
-- POR QUÉ COLUMNAS Y NO UN ESTADO NUEVO. `work_order_status` es el carril del
-- kanban (reception → … → historical) y lo leen el barrido de notificaciones, los
-- reportes y el FE. Un valor `voided` obligaría a revisar cada `in (...)` del
-- sistema y, peor, perdería el estado en el que estaba la orden (reactivar tiene
-- que devolverla a SU carril). Anulada = `voided_at is not null`, ortogonal al
-- status, que no se toca.
--
-- QUÉ HACE `void_work_order` (una sola transacción, todo o nada):
--   1. Solo el DUEÑO del taller de la orden. Bloquea la fila (`for update`).
--   2. Rechaza si la orden tiene una factura EMITIDA (`processing` o
--      `authorized`, 0049): un comprobante fiscal vivo no queda colgando de una
--      orden anulada; primero se anula en el SRI (y se marca `voided`). Se mira
--      SOLO por orden, no por la cotización: el caso típico es una orden duplicada
--      de la MISMA cotización, y la factura de la orden buena no debe bloquearla.
--   3. Cierra las sesiones de tiempo corriendo (0027).
--   4. DEVUELVE EL STOCK con movimientos `adjustment` (no borrando consumos): por
--      producto, inserta `-SUM(quantity)` de todos los movimientos de la orden.
--      El kardex queda auditable y "stock = SUM(quantity)" (0008) sigue valiendo.
--   5. Cancela las notificaciones de la orden que todavía no salieron (ver abajo).
--   6. Marca voided_at / voided_by / void_reason y deja una entrada en la
--      bitácora (`work_order_logs`), que sobrevive a una reactivación.
--
-- QUÉ HACE `reactivate_work_order`: vuelve a descontar el stock SIN parsear
-- notas — por producto, objetivo = SUM de los `consumption` de la orden, actual =
-- SUM de todos sus movimientos; si difieren, un `adjustment` por la diferencia.
-- Converge en cualquier secuencia anular → reactivar → editar consumos → anular…
-- El stock PUEDE quedar negativo (nada en el esquema lo prohíbe: `quantity` no
-- tiene check de signo y v_product_stock es un SUM; la regla "no negativo" del FE
-- es solo del ajuste MANUAL). Las sesiones de tiempo cerradas al anular NO se
-- reabren, y las notificaciones canceladas NO se reviven (ver abajo).
--
-- NOTIFICACIONES PENDIENTES. `notification_status` (0001) es
-- queued/sent/delivered/failed — no hay `cancelled`, y agregar un valor sería un
-- `ADD VALUE` en su propia migración + revisar el webhook de recibos (0038). El
-- drenado de notification-dispatch toma `queued` + (`failed` con attempts < 5).
-- Cancelar = pasar esas filas a `failed` con `attempts = greatest(attempts, 5)`
-- (fuera del drenado para siempre), `error = 'cancelada: la orden fue anulada'` y
-- `payload.cancelled = 'work_order_voided'` como marca legible. Las filas NO se
-- borran: siguen ocupando su clave de dedupe (0034), así que ningún barrido las
-- vuelve a encolar. Se hace EN la misma transacción que voided_at, así que vale
-- también contra la función VIEJA (antes del deploy). Al REACTIVAR no se reviven:
-- un aviso que llega tarde (p. ej. "recibimos tu vehículo" un día después) es peor
-- que uno que no llega, y el WhatsApp de la recepción casi siempre ya salió en el
-- primer minuto. Los avisos FUTUROS de la orden reactivada (listo, entregado) sí
-- salen normalmente: sus pares nunca se encolaron. Corolario (verificado en local):
-- una orden anulada ANTES de su primer tick nunca encoló la recepción, así que al
-- reactivarla el barrido la ve (reactivar bumpea updated_at) y manda "recibimos tu
-- vehículo" en el tick siguiente — correcto: la orden vuelve a estar viva.
--
-- QUIÉN MÁS LEE work_orders (revisado en todas las migraciones):
--   - v_product_stock (0008): no lee work_orders; una anulada netea 0 en sus
--     movimientos, así que el stock ya es correcto sin filtrar.
--   - private.is_my_work_order (0021) y las policies del técnico (0022, 0025, 0027,
--     0030, 0039): NO se filtran. El técnico sigue VIENDO su orden asignada anulada
--     (el FE la muestra como "Anulada"); escribirla lo frenan las guardias.
--     Residual aceptado: bitácora, fotos, selecciones del catálogo y comentarios por
--     módulo siguen admitiendo INSERT sobre una anulada (no tocan stock ni avisos).
--   - 0041 / 0044: backfills de una sola vez, ya aplicados.
--   Los reportes y el kanban viven en el FE: ahí se filtra `voided_at is null`.
--
-- GUARDIA EN LA DB (trigger `work_orders_void_guard`):
--   - `voided_at` / `voided_by` / `void_reason` solo cambian a través de las dos
--     RPC, que encienden el GUC transaccional `antawa.work_order_void` con
--     `set_config(..., true)` y lo apagan antes de volver. PostgREST no expone
--     `set_config` (pg_catalog no está en db-schemas) y cada request es su propia
--     transacción, así que un cliente no lo puede encender. Aplica a TODOS los
--     roles, service_role incluido (ni el importador ni el dispatcher escriben
--     esas columnas).
--   - Una orden anulada NO admite ningún UPDATE (status, técnico, km, lo que sea;
--     ni del dueño ni del técnico vía `work_orders_tech_update` de 0022). Única
--     excepción: las cascadas `ON DELETE SET NULL` de sus FKs (appointment_id,
--     technician_id, created_by, quote_id, voided_by) — sin ella, borrar el login
--     de un técnico (`technician-access` → deleteUser) o una cita enlazada a una
--     orden anulada fallaría. Se reconoce por forma: lo único que cambia son
--     columnas FK que pasan a NULL (más updated_at, que bumpea set_updated_at).
--   - INSERT con voided_* no nulos también se rechaza (una orden no nace anulada
--     sin pasar por la devolución de stock).
--   Dispatcher e importador: verificado que NINGUNA Edge Function hace UPDATE
--   sobre work_orders (el dispatcher escribe `work_order_deliveries.
--   delivery_pdf_url`, otra tabla) y el importador de Zoho (FE/scripts/zoho) solo
--   INSERTA órdenes sin voided_* y salta las ya mapeadas.
--
-- GUARDIAS EN LAS HIJAS (coherencia del stock y del timer):
--   - inventory_movements: INSERT/UPDATE/DELETE de un movimiento cuya orden
--     (vieja o nueva) está anulada → rechazado. Sin esto, editar o borrar un
--     consumo de una orden anulada (el FE lo permite antes de Entrega, FE#73)
--     inflaría el stock: la devolución ya se hizo sobre el neto. Las cascadas
--     (borrar un producto o la orden) pasan (`pg_trigger_depth() > 1`).
--   - work_order_time_logs: no se inicia (ni se reabre ni se mueve a) una sesión
--     sobre una orden anulada.
--   Ambas leen la orden con `for key share`: si el anulado está en vuelo, esperan
--   su commit y ven la fila ya anulada (READ COMMITTED sigue la cadena de update).
--
-- CONCURRENCIA CON LA FACTURACIÓN. La RPC toma la orden `for update` (bloquea el
-- `for key share` del FK de un INSERT de factura nueva) y las facturas de la orden
-- `for update` (serializa con `acquire_invoice_for_emission`, que también las
-- bloquea). `invoice-emit` relee la orden DESPUÉS de tomar su lock y lo libera si
-- quedó anulada: no hay intercalado que termine en una factura emitida sobre una
-- orden anulada.
--
-- SECURITY DEFINER (y no invoker), por tres razones: (a) el dueño no tiene UPDATE
-- sobre notification_log (0009: solo lectura); (b) la RPC tiene que ver/bloquear
-- facturas en cualquier estado — bajo RLS el `for update` aplicaría el USING de
-- `invoices_owner_update` (solo draft) y una factura autorizada sería "invisible",
-- justo la que hay que detectar; (c) la autorización queda en UN lugar explícito:
-- `private.current_shop_id()` es NULL para técnicos (0021), admins y usuarios sin
-- perfil, así que solo un dueño pasa, y únicamente sobre órdenes de SU taller. El
-- técnico no puede anular ni sus órdenes asignadas (su carve-out de 0022 es sobre
-- la tabla, no sobre esta RPC). search_path = '' y todo calificado.
--
-- ERRORES (el FE los mapea por `code` + `hint`; el hint es la clave estable):
--   code   HTTP hint
--   42501  403  not_owner              el caller no es dueño de un taller
--   PT404  404  not_found              la orden no existe o es de otro taller
--   22023  400  reason_required        motivo vacío (solo void)
--   PT409  409  already_voided         void sobre una orden ya anulada
--   PT409  409  has_issued_invoice     void con factura processing/authorized
--   PT409  409  not_voided             reactivate sobre una orden no anulada
--   42501  403  void_columns_protected UPDATE/INSERT directo de voided_* (guardia)
--   PT409  409  work_order_voided      cualquier otro UPDATE de una orden anulada, o
--                                      movimiento/sesión de tiempo sobre ella (guardias)
-- Por qué `PTxxx` (PostgREST fija el HTTP status con esos SQLSTATE) y no 55000 /
-- P0002: esos dos salen como 500, y PostgREST LOGUEA los 5xx — verificado contra
-- el stack local (PostgREST 14.5): con un mensaje no-ASCII ("está anulada") el
-- log se corta y la respuesta llega como texto plano "Something went wrong", sin
-- code ni hint. Un 4xx no se loguea y llega como JSON. Además 409/404 es la
-- semántica correcta (estado en conflicto / no encontrada), no un error interno.
--
-- ⚠️ ORDEN DE DEPLOY: `db push` PRIMERO, `functions deploy notification-dispatch
-- invoice-emit` DESPUÉS, en la misma sesión. La función VIEJA con esta migración
-- aplicada sigue funcionando (no conoce la columna; la RPC igual cancela lo
-- pendiente). La NUEVA sin la migración rompería el barrido (filtra por
-- `voided_at`). En la ventana entre ambos, el barrido viejo podría encolar un par
-- que faltara de una orden anulada (solo si se anula dentro del primer minuto de
-- vida, antes del primer tick): deployar la función enseguida.
-- Después: `npm run gen:types` en el FE (columnas + 2 RPC nuevas).
-- =============================================================================

-- ---------- Columnas -----------------------------------------------------------
alter table public.work_orders
  add column voided_at   timestamptz,
  add column voided_by   uuid references auth.users(id) on delete set null,
  add column void_reason text;

-- Van juntos: anulada ⇔ con motivo no vacío. voided_by puede quedar NULL (el FK
-- lo anula si se borra el usuario) sin que la orden deje de estar anulada.
alter table public.work_orders
  add constraint work_orders_void_ck check (
    (voided_at is null and void_reason is null)
    or (voided_at is not null and void_reason is not null and length(btrim(void_reason)) > 0)
  );

-- ---------- Guardia de work_orders -------------------------------------------
create or replace function private.work_orders_void_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  -- Las únicas columnas que una cascada ON DELETE SET NULL puede tocar.
  v_fk_cols text[] := array['appointment_id', 'technician_id', 'created_by', 'quote_id', 'voided_by'];
  v_new     jsonb;
  v_old     jsonb;
  v_key     text;
  v_changed boolean := false;
begin
  -- Camino de las RPC: ellas mismas validan todo.
  if coalesce(current_setting('antawa.work_order_void', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.voided_at is not null or new.voided_by is not null or new.void_reason is not null then
      raise exception 'work_orders: una orden se anula con void_work_order, no con un insert'
        using errcode = '42501', hint = 'void_columns_protected';
    end if;
    return new;
  end if;

  -- UPDATE de una orden activa: todo vale menos tocar voided_*.
  if old.voided_at is null then
    if new.voided_at   is distinct from old.voided_at
       or new.voided_by   is distinct from old.voided_by
       or new.void_reason is distinct from old.void_reason then
      raise exception 'work_orders: una orden se anula con void_work_order y se reactiva con reactivate_work_order'
        using errcode = '42501', hint = 'void_columns_protected';
    end if;
    return new;
  end if;

  -- UPDATE de una orden ANULADA: solo la forma de una cascada SET NULL.
  v_new := to_jsonb(new) - 'updated_at';
  v_old := to_jsonb(old) - 'updated_at';
  foreach v_key in array v_fk_cols loop
    if (v_new -> v_key) is distinct from (v_old -> v_key) then
      if jsonb_typeof(v_new -> v_key) <> 'null' then
        v_changed := false;
        exit;
      end if;
      v_changed := true;
    end if;
    v_new := v_new - v_key;
    v_old := v_old - v_key;
  end loop;
  if v_changed and v_new = v_old then
    return new;
  end if;

  raise exception 'work_orders: la orden % está anulada; reactívala para modificarla', old.id
    using errcode = 'PT409', hint = 'work_order_voided';
end;
$$;
revoke execute on function private.work_orders_void_guard() from public;

-- Corre después de set_work_orders_updated_at (orden alfabético de los BEFORE);
-- da igual: updated_at no entra en la comparación.
create trigger work_orders_void_guard
  before insert or update on public.work_orders
  for each row execute function private.work_orders_void_guard();

-- ---------- Guardias de las hijas --------------------------------------------
-- Helper: falla si la orden está anulada. SECURITY DEFINER para ver la orden sin
-- RLS (bajo RLS una orden "invisible" pasaría el chequeo). `for key share`: si un
-- void_work_order está en vuelo (tiene la fila `for update`), espera su commit y
-- lee la versión anulada. Sin EXECUTE para authenticated: lo llaman los triggers
-- de abajo, que son SECURITY DEFINER (un trigger corre con el rol del caller, y
-- el caller —dueño o técnico— no tiene por qué poder invocar el helper suelto).
create or replace function private.assert_work_order_not_voided(p_work_order_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_voided_at timestamptz;
begin
  select w.voided_at into v_voided_at
    from public.work_orders w
   where w.id = p_work_order_id
     for key share;
  if v_voided_at is not null then
    raise exception 'la orden % está anulada; reactívala para modificarla', p_work_order_id
      using errcode = 'PT409', hint = 'work_order_voided';
  end if;
end;
$$;
revoke execute on function private.assert_work_order_not_voided(uuid) from public;

create or replace function private.inventory_movements_void_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Las RPC escriben los ajustes de devolución / re-descuento.
  if coalesce(current_setting('antawa.work_order_void', true), '') = 'on'
     -- Cascadas: borrar un producto (cascade) o la orden (set null). Llegan desde
     -- un trigger de integridad referencial, nunca desde un request.
     or pg_trigger_depth() > 1 then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op in ('UPDATE', 'DELETE') and old.work_order_id is not null then
    perform private.assert_work_order_not_voided(old.work_order_id);
  end if;
  if tg_op in ('INSERT', 'UPDATE') and new.work_order_id is not null then
    perform private.assert_work_order_not_voided(new.work_order_id);
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
revoke execute on function private.inventory_movements_void_guard() from public;

create trigger inventory_movements_void_guard
  before insert or update or delete on public.inventory_movements
  for each row execute function private.inventory_movements_void_guard();

create or replace function private.work_order_time_logs_void_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('antawa.work_order_void', true), '') = 'on' then
    return new;
  end if;
  -- Corregir timestamps de una sesión YA cerrada de una orden anulada sigue
  -- permitido (es dato del pasado); lo que no: abrir, reabrir o mover una sesión.
  if tg_op = 'INSERT'
     or new.work_order_id is distinct from old.work_order_id
     or (new.ended_at is null and old.ended_at is not null) then
    perform private.assert_work_order_not_voided(new.work_order_id);
  end if;
  return new;
end;
$$;
revoke execute on function private.work_order_time_logs_void_guard() from public;

create trigger work_order_time_logs_void_guard
  before insert or update on public.work_order_time_logs
  for each row execute function private.work_order_time_logs_void_guard();

-- ---------- RPC: anular -------------------------------------------------------
create or replace function public.void_work_order(p_id uuid, p_reason text)
returns public.work_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop_id uuid := (select private.current_shop_id());
  v_uid     uuid := (select auth.uid());
  v_reason  text := btrim(coalesce(p_reason, ''));
  v_wo      public.work_orders;
  v_folio   text;
begin
  if v_shop_id is null then
    raise exception 'void_work_order: solo el dueño del taller puede anular órdenes'
      using errcode = '42501', hint = 'not_owner';
  end if;

  select * into v_wo
    from public.work_orders w
   where w.id = p_id and w.shop_id = v_shop_id
     for update;
  if not found then
    raise exception 'void_work_order: la orden no existe o no es de tu taller'
      using errcode = 'PT404', hint = 'not_found';
  end if;
  if v_wo.voided_at is not null then
    raise exception 'void_work_order: la orden ya está anulada'
      using errcode = 'PT409', hint = 'already_voided';
  end if;
  if v_reason = '' then
    raise exception 'void_work_order: el motivo de la anulación es obligatorio'
      using errcode = '22023', hint = 'reason_required';
  end if;

  -- Bloqueo por factura emitida. Primero se BLOQUEAN las facturas de la orden
  -- (serializa con acquire_invoice_for_emission); después se mira su estado.
  perform 1 from public.invoices i
   where i.work_order_id = p_id and i.shop_id = v_shop_id
     for update;
  if exists (
    select 1 from public.invoices i
     where i.work_order_id = p_id and i.shop_id = v_shop_id
       and i.status in ('processing', 'authorized')
  ) then
    raise exception 'void_work_order: la orden tiene una factura emitida; anúlala en el SRI antes de anular la orden'
      using errcode = 'PT409', hint = 'has_issued_invoice';
  end if;

  v_folio := 'OT-' || lpad(v_wo.order_number::text, 4, '0');
  perform set_config('antawa.work_order_void', 'on', true);

  -- Sesiones de tiempo corriendo. greatest(): el CHECK de 0027 exige
  -- ended_at > started_at; en la práctica now() ya es mayor (otra transacción).
  update public.work_order_time_logs t
     set ended_at = greatest(now(), t.started_at + interval '1 millisecond')
   where t.work_order_id = p_id and t.shop_id = v_shop_id and t.ended_at is null;

  -- Devolución de stock: un ajuste por producto con el neto de la orden en
  -- negativo. unit_cost = costo promedio ponderado de los consumos con costo.
  insert into public.inventory_movements
    (shop_id, product_id, movement_type, quantity, unit_cost, work_order_id, notes, created_by)
  select v_shop_id,
         m.product_id,
         'adjustment',
         -sum(m.quantity),
         round(
           sum(m.quantity * m.unit_cost) filter (where m.movement_type = 'consumption' and m.unit_cost is not null)
           / nullif(sum(m.quantity) filter (where m.movement_type = 'consumption' and m.unit_cost is not null), 0),
           2),
         p_id,
         'Devolución por anulación de la orden ' || v_folio,
         v_uid
    from public.inventory_movements m
   where m.work_order_id = p_id and m.shop_id = v_shop_id
   group by m.product_id
  having sum(m.quantity) <> 0;

  -- Avisos que todavía no salieron: fuera del drenado para siempre (ver header).
  update public.notification_log n
     set status   = 'failed',
         attempts = greatest(n.attempts, 5),
         error    = 'cancelada: la orden fue anulada',
         payload  = coalesce(n.payload, '{}'::jsonb)
                    || jsonb_build_object('cancelled', 'work_order_voided', 'cancelled_at', now())
   where n.related_entity_type = 'work_order'
     and n.related_entity_id = p_id
     and n.shop_id = v_shop_id
     and (n.status = 'queued' or (n.status = 'failed' and n.attempts < 5));

  update public.work_orders w
     set voided_at   = now(),
         voided_by   = v_uid,
         void_reason = v_reason
   where w.id = p_id
  returning * into v_wo;

  insert into public.work_order_logs (shop_id, work_order_id, notes, created_by)
  values (v_shop_id, p_id, 'Orden anulada. Motivo: ' || v_reason, v_uid);

  perform set_config('antawa.work_order_void', '', true);
  return v_wo;
end;
$$;

-- ---------- RPC: reactivar ----------------------------------------------------
create or replace function public.reactivate_work_order(p_id uuid)
returns public.work_orders
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shop_id uuid := (select private.current_shop_id());
  v_uid     uuid := (select auth.uid());
  v_wo      public.work_orders;
  v_folio   text;
begin
  if v_shop_id is null then
    raise exception 'reactivate_work_order: solo el dueño del taller puede reactivar órdenes'
      using errcode = '42501', hint = 'not_owner';
  end if;

  select * into v_wo
    from public.work_orders w
   where w.id = p_id and w.shop_id = v_shop_id
     for update;
  if not found then
    raise exception 'reactivate_work_order: la orden no existe o no es de tu taller'
      using errcode = 'PT404', hint = 'not_found';
  end if;
  if v_wo.voided_at is null then
    raise exception 'reactivate_work_order: la orden no está anulada'
      using errcode = 'PT409', hint = 'not_voided';
  end if;

  v_folio := 'OT-' || lpad(v_wo.order_number::text, 4, '0');
  perform set_config('antawa.work_order_void', 'on', true);

  -- Re-descuento: por producto, llevar el neto de la orden de vuelta a la suma
  -- de sus consumos. Sin parsear notas: los ajustes de anulación/reactivación son
  -- los únicos `adjustment` con work_order_id, así que objetivo − actual es
  -- exactamente lo que falta (cero si nada cambió).
  insert into public.inventory_movements
    (shop_id, product_id, movement_type, quantity, unit_cost, work_order_id, notes, created_by)
  select v_shop_id,
         m.product_id,
         'adjustment',
         coalesce(sum(m.quantity) filter (where m.movement_type = 'consumption'), 0) - sum(m.quantity),
         round(
           sum(m.quantity * m.unit_cost) filter (where m.movement_type = 'consumption' and m.unit_cost is not null)
           / nullif(sum(m.quantity) filter (where m.movement_type = 'consumption' and m.unit_cost is not null), 0),
           2),
         p_id,
         'Re-descuento por reactivación de la orden ' || v_folio,
         v_uid
    from public.inventory_movements m
   where m.work_order_id = p_id and m.shop_id = v_shop_id
   group by m.product_id
  having coalesce(sum(m.quantity) filter (where m.movement_type = 'consumption'), 0) <> sum(m.quantity);

  update public.work_orders w
     set voided_at   = null,
         voided_by   = null,
         void_reason = null
   where w.id = p_id
  returning * into v_wo;

  insert into public.work_order_logs (shop_id, work_order_id, notes, created_by)
  values (v_shop_id, p_id, 'Orden reactivada', v_uid);

  perform set_config('antawa.work_order_void', '', true);
  return v_wo;
end;
$$;

-- Default privileges de Supabase: EXECUTE a anon en toda función nueva de public
-- (0027/0037) — el revoke de PUBLIC no alcanza.
revoke execute on function public.void_work_order(uuid, text) from public, anon;
grant  execute on function public.void_work_order(uuid, text) to authenticated;
revoke execute on function public.reactivate_work_order(uuid) from public, anon;
grant  execute on function public.reactivate_work_order(uuid) to authenticated;

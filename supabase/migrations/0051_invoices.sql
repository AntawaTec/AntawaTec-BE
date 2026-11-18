-- =============================================================================
-- 0051_invoices.sql
-- Facturación electrónica SRI — facturas e ítems.
--
-- QUIÉN ESCRIBE QUÉ.
--   - El DUEÑO arma el BORRADOR desde la PWA (insert-first + compensación, con
--     `shop_id` en `invoices` e `invoice_items`, igual que las cotizaciones).
--     La RLS solo le deja escribir filas en `status = 'draft'` y con los campos
--     que asigna el SRI/proveedor en NULL: no puede fabricar una factura
--     "autorizada", ni sacarla de borrador, ni tocar una ya emitida.
--   - TODO lo demás (lock de emisión, número, clave de acceso, autorización,
--     rutas del XML/RIDE, errores del SRI, anulación) lo escribe el service_role
--     desde las Edge Functions `invoice-emit`, `invoice-webhook` e
--     `invoice-reconcile`.
--   - El técnico no ve nada (default-deny: current_shop_id() es NULL para él).
--
-- SIN CONTADOR PROPIO. El secuencial lo asigna el proveedor
-- (sequentialMode = platform) y se guarda el que devuelve al autorizar. Una
-- cotización no es comprobante fiscal (ver el log de 0012); una factura sí, y
-- su numeración la lleva quien firma y envía al SRI.
--
-- SIN UNIQUE POR ORDEN. Una orden puede tener dos facturas legítimas (p. ej. la
-- de la aseguradora + la del deducible al cliente); el FE avisa si la orden ya
-- tiene una autorizada.
--
-- Montos: `numeric`, nunca float (CLAUDE.md). Cantidades y precios unitarios con
-- hasta 6 decimales (lo que admite el XML del SRI); todo lo demás a 2.
-- Los totales los calcula el FE y `invoice-emit` los RECALCULA en servidor con la
-- misma regla (_shared/billing/sri.ts) y rechaza la emisión si no coinciden.
-- =============================================================================

-- ---------- Uniques de apoyo para FKs compuestos ------------------------------
-- (id, shop_id) en customers/products para que una factura/ítem no pueda colgar
-- de un cliente/producto de OTRO taller (la RLS no valida FKs cross-tenant; ver
-- CLAUDE.md y quotes_id_shop_key en 0018). `id` ya es PK, así que el unique no
-- puede fallar sobre los datos existentes: es solo el índice que exige el FK.
alter table public.customers
  add constraint customers_id_shop_key unique (id, shop_id);
alter table public.products
  add constraint products_id_shop_key unique (id, shop_id);

-- ---------- invoices ----------------------------------------------------------
create table public.invoices (
  id                    uuid primary key default gen_random_uuid(),
  shop_id               uuid not null references public.shops(id) on delete cascade,
  work_order_id         uuid,
  quote_id              uuid,
  customer_id           uuid,
  status                public.invoice_status not null default 'draft',

  -- Serie y ambiente: los fija invoice-emit al tomar el lock, desde
  -- shop_billing_settings (el borrador puede no tenerlos todavía).
  environment           text,
  establecimiento       text,
  punto_emision         text,
  issued_on             date,           -- fechaEmision (hora de Ecuador)

  -- Asignados por el SRI / proveedor. SOLO los escribe el service_role (la RLS
  -- del dueño exige que sigan NULL).
  secuencial            text,           -- 9 dígitos (000000042)
  access_key            text,           -- clave de acceso, 49 dígitos
  authorization_number  text,
  authorized_at         timestamptz,
  provider_document_id  text,
  provider_status       text,           -- estado crudo del proveedor (AUTHORIZED, RECEIVED…)
  error                 jsonb,          -- mensajes del SRI / proveedor para el usuario
  xml_path              text,           -- bucket invoices: {shop_id}/{id}/factura.xml
  ride_path             text,           -- bucket invoices: {shop_id}/{id}/ride.pdf
  voided_at             timestamptz,

  -- Snapshot del comprador: la factura NO cambia si después se edita el cliente.
  buyer_id_type         public.buyer_id_type not null,
  buyer_id_number       text not null,
  buyer_name            text not null,
  buyer_address         text,
  buyer_email           text,
  buyer_phone           text,

  subtotal              numeric(14,2) not null default 0,   -- totalSinImpuestos (neto de descuentos)
  discount_total        numeric(14,2) not null default 0,   -- totalDescuento
  tax_total             numeric(14,2) not null default 0,   -- Σ IVA por tarifa
  total                 numeric(14,2) not null default 0,   -- importeTotal
  payment_method        text not null default '01',         -- formaPago SRI (tabla 24)

  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  constraint invoices_id_shop_key unique (id, shop_id),

  -- FKs COMPUESTOS (lección de 0018): la orden, la cotización y el cliente deben
  -- ser del MISMO taller que la factura. `set null (col)` (PG15+) anula SOLO la
  -- referencia y no `shop_id`: borrar una orden/cliente NO borra un comprobante
  -- fiscal emitido, solo pierde el enlace.
  constraint invoices_work_order_fk
    foreign key (work_order_id, shop_id) references public.work_orders (id, shop_id)
    on delete set null (work_order_id),
  constraint invoices_quote_fk
    foreign key (quote_id, shop_id) references public.quotes (id, shop_id)
    on delete set null (quote_id),
  constraint invoices_customer_fk
    foreign key (customer_id, shop_id) references public.customers (id, shop_id)
    on delete set null (customer_id),

  constraint invoices_environment_ck
    check (environment is null or environment in ('test', 'production')),
  constraint invoices_establecimiento_ck
    check (establecimiento is null or establecimiento ~ '^[0-9]{3}$'),
  constraint invoices_punto_emision_ck
    check (punto_emision is null or punto_emision ~ '^[0-9]{3}$'),
  constraint invoices_secuencial_ck
    check (secuencial is null or secuencial ~ '^[0-9]{9}$'),
  constraint invoices_access_key_ck
    check (access_key is null or access_key ~ '^[0-9]{49}$'),
  constraint invoices_payment_method_ck
    check (payment_method in ('01', '15', '16', '17', '18', '19', '20', '21')),
  constraint invoices_amounts_ck
    check (subtotal >= 0 and discount_total >= 0 and tax_total >= 0 and total >= 0),
  constraint invoices_buyer_name_ck
    check (length(btrim(buyer_name)) between 1 and 300),
  constraint invoices_buyer_id_number_ck
    check (length(btrim(buyer_id_number)) between 1 and 20),
  -- Consumidor final: identificación fija del SRI y tope de USD 50 por factura.
  constraint invoices_consumidor_final_ck
    check (buyer_id_type <> 'consumidor_final'
           or (buyer_id_number = '9999999999999' and total <= 50))
);

create index invoices_shop_status_idx   on public.invoices (shop_id, status, created_at desc);
create index invoices_work_order_idx    on public.invoices (work_order_id) where work_order_id is not null;
-- Correlación del webhook cuando el evento no trae idempotencyKey.
create index invoices_access_key_idx    on public.invoices (access_key) where access_key is not null;
create index invoices_provider_doc_idx  on public.invoices (provider_document_id) where provider_document_id is not null;
-- invoice-reconcile: solo filas en vuelo.
create index invoices_processing_idx    on public.invoices (updated_at) where status = 'processing';

create trigger set_invoices_updated_at before update on public.invoices
  for each row execute function public.set_updated_at();

-- ---------- invoice_items -----------------------------------------------------
create table public.invoice_items (
  id             uuid primary key default gen_random_uuid(),
  shop_id        uuid not null references public.shops(id) on delete cascade,
  invoice_id     uuid not null,
  position       int not null default 0,
  code           text,                       -- codigoPrincipal (≤ 25)
  description    text not null,              -- descripcion (≤ 300)
  quantity       numeric(18,6) not null,
  unit_price     numeric(18,6) not null,
  discount       numeric(14,2) not null default 0,
  tax_code       text not null default '4',  -- codigoPorcentaje IVA (tabla 17)
  tax_rate       numeric(5,2) not null default 15,
  line_subtotal  numeric(14,2) not null,     -- precioTotalSinImpuesto
  line_tax       numeric(14,2) not null,     -- valor del IVA de la línea
  product_id     uuid,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint invoice_items_invoice_fk
    foreign key (invoice_id, shop_id) references public.invoices (id, shop_id)
    on delete cascade,
  constraint invoice_items_product_fk
    foreign key (product_id, shop_id) references public.products (id, shop_id)
    on delete set null (product_id),

  constraint invoice_items_quantity_ck   check (quantity > 0),
  constraint invoice_items_unit_price_ck check (unit_price >= 0),
  constraint invoice_items_discount_ck   check (discount >= 0),
  constraint invoice_items_amounts_ck    check (line_subtotal >= 0 and line_tax >= 0),
  constraint invoice_items_description_ck
    check (length(btrim(description)) between 1 and 300),
  constraint invoice_items_code_ck
    check (code is null or length(code) <= 25),
  -- Tarifa coherente con el código SRI: 0 → 0 %, 4 → 15 %, 5 → 5 %,
  -- 6 (no objeto) y 7 (exento) → 0 %. Si el SRI cambia la tarifa general, es una
  -- migración nueva (y la tabla de _shared/billing/sri.ts + la del FE).
  constraint invoice_items_tax_ck
    check (   (tax_code = '0' and tax_rate = 0)
           or (tax_code = '4' and tax_rate = 15)
           or (tax_code = '5' and tax_rate = 5)
           or (tax_code = '6' and tax_rate = 0)
           or (tax_code = '7' and tax_rate = 0))
);

create index invoice_items_invoice_idx on public.invoice_items (invoice_id, position);

create trigger set_invoice_items_updated_at before update on public.invoice_items
  for each row execute function public.set_updated_at();

-- ---------- Ítems inmutables fuera de borrador ---------------------------------
-- La RLS de invoice_items solo mira el shop_id de la fila (column-agnostic): sin
-- esto, el dueño podría agregar/editar/borrar ítems de una factura ya emitida o
-- en emisión. El trigger bloquea cualquier INSERT/UPDATE/DELETE cuyo padre no
-- esté en 'draft'.
--
-- Detalles que importan:
--   - `for share` sobre el padre: serializa con el `for update` de
--     acquire_invoice_for_emission. Un ítem que entra en carrera con el lock o
--     termina antes (y la emisión lo ve, porque invoice-emit relee los ítems
--     DESPUÉS de tomar el lock) o espera y falla (el padre ya no es borrador).
--   - SECURITY DEFINER: corre sin RLS. Con RLS, el `for share` aplicaría el USING
--     de la policy UPDATE de invoices (status = 'draft') y un padre no-borrador
--     se vería como "inexistente" — que es justo el caso que se PERMITE abajo.
--   - Padre inexistente = borrado en CASCADA de un borrador (el trigger del hijo
--     corre cuando la fila padre ya no está): se permite. Un DELETE directo del
--     dueño sobre ítems de un padre no-borrador sí encuentra el padre y falla.
--   - Aplica a TODOS, service_role incluido: el servidor nunca escribe ítems (las
--     funciones de emisión solo los leen), así que no necesita saltárselo. Borrar
--     una factura emitida como service_role cascadea igual (padre inexistente).
create or replace function private.invoice_items_require_draft()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.invoice_status;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select i.status into v_status
      from public.invoices i
     where i.id = old.invoice_id
       for share;
    if found and v_status <> 'draft' then
      raise exception 'invoice_items: la factura % no es un borrador (%)', old.invoice_id, v_status
        using errcode = '42501';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select i.status into v_status
      from public.invoices i
     where i.id = new.invoice_id
       for share;
    -- En INSERT/UPDATE el padre DEBE existir (el FK lo exige igual; acá se
    -- falla con un mensaje claro en vez de dejar pasar).
    if not found or v_status <> 'draft' then
      raise exception 'invoice_items: la factura % no es un borrador', new.invoice_id
        using errcode = '42501';
    end if;
    return new;
  end if;

  return old;
end;
$$;

create trigger invoice_items_require_draft
  before insert or update or delete on public.invoice_items
  for each row execute function private.invoice_items_require_draft();

-- =====================================================================
-- RLS
-- =====================================================================
alter table public.invoices      enable row level security;
alter table public.invoice_items enable row level security;

-- ----- invoices -----
create policy invoices_select on public.invoices
  for select to authenticated
  using ( shop_id = (select private.current_shop_id())
          or (select private.is_platform_admin()) );

-- El dueño crea BORRADORES. El WITH CHECK fija todo lo que no le corresponde:
-- estado draft y los campos que asigna el SRI/proveedor en NULL.
create policy invoices_owner_insert on public.invoices
  for insert to authenticated
  with check (
    shop_id = (select private.current_shop_id())
    and status = 'draft'
    and secuencial is null
    and access_key is null
    and authorization_number is null
    and authorized_at is null
    and provider_document_id is null
    and provider_status is null
    and xml_path is null
    and ride_path is null
    and voided_at is null
  );

-- Solo borradores, antes Y después (USING + WITH CHECK, plantilla de 0042): no
-- puede editar una emitida ni pasar una propia a 'processing'/'authorized'.
create policy invoices_owner_update on public.invoices
  for update to authenticated
  using (
    shop_id = (select private.current_shop_id())
    and status = 'draft'
  )
  with check (
    shop_id = (select private.current_shop_id())
    and status = 'draft'
    and secuencial is null
    and access_key is null
    and authorization_number is null
    and authorized_at is null
    and provider_document_id is null
    and provider_status is null
    and xml_path is null
    and ride_path is null
    and voided_at is null
  );

-- Borrar = descartar un borrador (cascadea sus ítems). Una factura emitida es
-- un comprobante fiscal: no se borra, se anula.
create policy invoices_owner_delete on public.invoices
  for delete to authenticated
  using (
    shop_id = (select private.current_shop_id())
    and status = 'draft'
  );

-- ----- invoice_items -----
-- Tenancy estándar por shop_id; la regla "solo si el padre es borrador" la pone
-- el trigger de arriba (la RLS no puede mirar la fila padre sin un subquery por
-- fila, y el trigger además serializa con el lock de emisión).
select private.apply_tenant_rls('invoice_items');

-- =====================================================================
-- Lock de emisión (atómico).
--
-- invoice-emit puede invocarse dos veces en paralelo (doble clic en "Emitir",
-- dos pestañas). La emisión en el proveedor es idempotente por
-- idempotencyKey = invoices.id, pero igual exactamente UNA invocación debe
-- manejar la factura. Comprobación + toma del lock en UNA sentencia (molde:
-- acquire_card_payment_intent de 0037): el CTE `as materialized` con
-- `for update` captura el estado ANTERIOR (RETURNING solo ve la fila nueva).
--
-- Pasa `draft` o `failed` a `processing`. Devuelve 0 filas si la factura no
-- existe o ya no está en uno de esos dos estados (el caller relee y responde
-- por estado). No recibe shop_id: el caller (service_role) ya filtró la factura
-- por el shop_id del perfil antes de llamar.
-- =====================================================================
create or replace function public.acquire_invoice_for_emission(p_id uuid)
returns table (
  id              uuid,
  shop_id         uuid,
  previous_status public.invoice_status
)
language sql
security definer
set search_path = ''
as $$
  with candidate as materialized (
    select i.id, i.status
      from public.invoices i
     where i.id = p_id
       and i.status in ('draft', 'failed')
       for update
  )
  update public.invoices i
     set status = 'processing'
    from candidate c
   where i.id = c.id
  returning i.id, i.shop_id, c.status;
$$;

-- Ver 0037 / 0050: el revoke a `public` solo NO alcanza (default privileges de
-- Supabase le dan EXECUTE a anon y authenticated). Sin esto, cualquier usuario
-- podría dejar facturas ajenas trabadas en 'processing'.
revoke execute on function public.acquire_invoice_for_emission(uuid)
  from public, anon, authenticated;
grant  execute on function public.acquire_invoice_for_emission(uuid)
  to service_role;

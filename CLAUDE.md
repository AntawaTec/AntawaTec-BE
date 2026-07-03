# CLAUDE.md — AntawaTec Backend (Supabase)

> Instrucciones para Claude Code. Este repo gestiona la **base de datos**, las
> **políticas de seguridad (RLS)**, el **storage** y las **Edge Functions** vía
> Supabase CLI. No hay servidor Node tradicional. Este repo es la **fuente de
> verdad**; Supabase es donde el backend *corre*.

## Visión general
Backend multi-tenant del **ecosistema Antawa**. AntawaTec es la primera app;
Driver, CarSOS y otras correrán sobre este mismo backend. Reemplaza un sistema
**Zoho Creator** con problemas estructurales — es una **re-arquitectura**, no una
migración directa. Base de datos **Postgres**. Desarrollo solo, asistido por IA.

## Stack
- **Supabase** (Postgres + Auth + Storage + Edge Functions)
- **Edge Functions** en **Deno** + TypeScript
- **Supabase CLI** para migraciones y despliegue
- Frontends (Next.js) consumen vía `@supabase/supabase-js` — viven en otros repos

## Comandos (Supabase CLI)
- `supabase start` / `supabase stop` — stack local (Docker)
- `supabase migration new <nombre>` — nueva migración
- `supabase db push` — aplica migraciones al proyecto remoto (linked)
- `supabase db reset` — recrea la DB local desde migraciones + seed
- `supabase migration list` — estado de migraciones local vs remoto
- `supabase migration repair --status applied <version>` — marca como aplicada sin ejecutar
- `supabase functions new <nombre>` / `serve` / `deploy <nombre>`
- `supabase secrets set KEY=value` — secretos de funciones
- `supabase gen types typescript --linked` — genera tipos TS del schema (para el front)

## Estructura de carpetas
```
supabase/
  migrations/       # 0001_foundation.sql ... 0019_*.sql. NUNCA editar una aplicada.
  functions/        # Edge Functions (una carpeta por función con index.ts)
    _shared/        # Código compartido entre funciones
  config.toml
scripts/            # Tooling de desarrollo (NO lo corre el CLI)
  verify_schema_rows.sql   # auditoría read-only del schema
  seed.sql                 # datos demo (requiere pegar 3 UIDs de auth)
  test_isolation.sql       # pruebas de aislamiento RLS
  test_quote_numbering.sql # valida el correlativo por taller de quotes (0012)
CLAUDE.md           # este archivo (raíz del repo)
README.md
```

## Principios de arquitectura (mandan sobre la conveniencia)
1. **El aislamiento es una garantía de la DB, no de la app.** Cada tabla operativa
   lleva `shop_id` y está protegida por RLS. Un bug en la app no debe poder filtrar
   datos entre talleres.
2. **Una sola entidad `work_orders`, muchas vistas.** Status Kanban, "en proceso",
   carga de técnicos y entrega son **vistas filtradas** de `work_orders.status`, no
   tablas separadas.
3. **El stock se calcula, no se escribe.** Sale de `SUM(quantity)` sobre
   `inventory_movements` (vista `v_product_stock`, `security_invoker=true`).
   Convención: cantidad **con signo** (compra +, consumo −, ajuste ±). No existe
   columna de stock editable.
4. **Extensible, pero SIN tablas del futuro.** Diseñar limpio para que Driver/CarSOS
   se sumen luego sin reescribir — pero **no crear tablas de esos productos en V1**.
5. **Auth: contraseña y magic link** (ambas opciones). Provisioning automático
   post-pago.
6. **Las notificaciones se loguean y reintentan**, no son fire-and-forget.
7. **Proveedores de pago intercambiables.** Hotmart hoy; aislar lo específico del
   proveedor para poder migrar a PlacetoPay sin tocar el provisioning.

## Multi-tenancy y RLS (regla de oro)
- **RLS ACTIVADO en TODAS las tablas.** Sin política = sin acceso.
- Helpers en el esquema `private` (`SECURITY DEFINER`, `search_path=''`):
  `private.current_shop_id()` y `private.is_platform_admin()`. Son SECURITY DEFINER
  para **evitar la recursión** de políticas sobre `profiles`.
- Generadores de políticas — **úsalos para toda tabla/bucket tenant nuevo**:
  - `private.apply_tenant_rls('<tabla>')` → 4 políticas estándar (dueño = CRUD sobre
    su `shop_id`; admin = lectura cross-shop).
  - `private.apply_tenant_storage_rls('<bucket>')` → políticas de storage por ruta.
- **Patrón de acceso:** `shop_owner` = CRUD sobre su propio `shop_id`. `antawa_admin`
  = **lectura** cross-shop en datos operativos. Escrituras de plataforma/migración
  van por **`service_role`** (salta RLS), nunca como usuario.
- **El esquema `private` está oculto al rol `authenticated`.** Las políticas RLS sí
  usan los helpers (por OID), pero **NO llames `private.*` por nombre desde el front**;
  para saber rol/taller del usuario, lee su propia fila de `profiles`.
- `service_role` **solo** en Edge Functions del lado servidor. Nunca expuesto al cliente.
- Cada tabla tenant nueva trae sus políticas RLS **en la misma migración** que la tabla.
- **RLS es column-agnostic y NO valida FKs cross-taller.** Dos patrones que mandan:
  - Escritura del dueño limitada a ALGUNAS columnas → RLS no alcanza (no restringe por
    columna). Usa una **RPC `SECURITY DEFINER`** con allowlist explícito que deriva el
    `shop_id` del caller (ej. `update_shop_settings` en `0013`). No abras un UPDATE amplio.
  - Un FK simple a otra tabla **no** garantiza que la fila apuntada sea del mismo taller
    (un `quote_id` de otro shop pasa el `WITH CHECK`, que solo mira el `shop_id` de la fila
    propia). Para FKs que cruzan tenant usa **FK compuesto `(id, shop_id)`** (requiere
    `unique(id, shop_id)` en la tabla destino), ej. `work_orders.quote_id → quotes(id, shop_id)`.

## Modelo de datos
23 tablas + vista `v_product_stock`. Detalle columna por columna en `migrations/`.
Dominios: tenancy/identidad · clientes/vehículos · catálogo de inventario ·
cotización · citas · órdenes de trabajo · movimientos de inventario · plataforma/admin.

Decisiones de modelado clave:
- `customers.is_fleet` (+`fleet_name`) colapsa Flota/Empresa (corrige la colisión de Zoho).
- `vehicles.fuel_type` corrige el `tipo_vehiculo` mal etiquetado de Zoho.
- Inventario unificado: `products` / `services` / `inventory_movements` / `suppliers`.
- `technicians` = staff del taller, **no usuarios de auth** en V1.
- `work_order_deliveries` 1:1 con la orden (cierre).
- `quote_items` apunta a `product_id` **o** `service_id` (nunca ambos).
- Roles: `antawa_admin` (sin shop) y `shop_owner` (un shop).

Agregados lote 1–2 (`0012`–`0019`, 2026-06): `quotes.quote_number` (correlativo por taller,
ver log) + tabla interna `private.shop_quote_counters`; `shops.logo_url`/`address`;
`products.category` (texto libre); `appointment_source += follow_up`; `appointments.reason`
(texto libre); `work_orders.quote_id` (FK compuesto de tenancy); unique parcial
`appointments.quote_id` (1:1 cita↔cotización).

## Los 11 módulos
10 operativos (PWA del dueño) + Admin Dashboard (web, Antawa):
Vehicle Data · Customer Data · Quotation · Appointments · Work Order ·
Progress Logs · Status Kanban (vista) · Vehicle Delivery · Inventory ·
Essential Reports (vistas/consultas) · **Admin Dashboard** (cross-shop).

## Storage
Buckets **privados** (`vehicle-media`, `signatures`, `documents`, `pdfs`,
`payment-proofs`). Convención de ruta: **`{shop_id}/...`** — las políticas verifican
`(storage.foldername(name))[1] = current_shop_id()`. Servir archivos con signed URLs.
`payment-proofs` es especial: lo escribe una Edge Function (service role) antes de
existir el tenant; solo admin lee.

`shop-logos` (`0014`) es el ÚNICO bucket **público** (el logo va en cotizaciones impresas /
PWA; no vale firmar cada render): lectura pública sin signed URL, escritura aislada por
`{shop_id}/` con políticas a medida (no el generador, que asume bucket privado + admin-read).
**Solo contenido raster** (`png/jpeg/webp`, **sin SVG** → XSS en el render cross-tenant del admin).

## Provisioning / embudo de ventas
Landing → (Hotmart webhook **o** transferencia con aprobación de admin) → creación
**idempotente** del tenant → email con magic link. `webhook_events` (con
`unique(provider, external_id)`) deduplica webhooks que se disparan dos veces.

## Notificaciones
WhatsApp Cloud API (Meta, oficial) primario; Resend como fallback de email. 6
plantillas: `appointment_confirmed`, `appointment_reminder_24h`, `vehicle_received`,
`quote_ready`, `vehicle_ready`, `delivery_completed`. Despachadas por Edge Functions
con cola de reintento; todo queda en `notification_log`. Sin chatbot en V1 (solo salida).

## Lógica que NO va en triggers de DB (va en Edge/app)
- Cotización aprobada → crear cita.
- Descuento de stock (escribir `inventory_movements` de consumo) al pasar la orden a
  `in_process`.
- Disparo de notificaciones según eventos del ciclo de vida.

## Convenciones SQL
- **snake_case**, tablas en plural. PK `id uuid default gen_random_uuid()`.
- `created_at` / `updated_at timestamptz default now()`; `updated_at` vía trigger
  `set_updated_at()`.
- Soft delete con `deleted_at` en registros de usuario (customers, vehicles, products).
- `created_by uuid references auth.users(id)` donde aplique auditoría.
- Conjuntos estables como `enum` de Postgres (status, tipos). Dinero como `numeric`.
- **Migraciones inmutables**: para corregir, crea una nueva; no edites una aplicada.
- `enum ADD VALUE` va **solo** en su migración: no puede usarse en la misma transacción que
  luego referencia el valor (Supabase envuelve cada archivo en una tx). Ej. `0016`.
- Constraints con **nombre explícito** para distinguir el `23505` desde el FE (ej. `0011`,
  `quotes_shop_number_unique`).
- Una migración = un concern. Si un cambio tiene riesgo sobre datos existentes (ej. un unique
  nuevo), aíslalo en su propia migración para no acoplar el riesgo al camino crítico (ej. el
  backstop de citas salió de `0018` a `0019`, y se verificó 0 duplicados antes de pushear).
- Todo cambio de schema pasa por migración; nada manual en el dashboard de producción.

## Edge Functions
- Una responsabilidad por función; utilidades compartidas en `_shared/`.
- Funciones planeadas: `hotmart-webhook`, `bank-transfer-approval`, `provision-tenant`,
  `whatsapp-dispatch`, `notification-retry`, `appointment-reminders`.
- Secretos con `Deno.env.get(...)`; nunca hardcodear.
- Webhooks y provisioning **idempotentes**. Códigos HTTP y errores consistentes.

## Migración de datos (Zoho)
TJ es dueño de la ejecución. ~12.000 registros, 18 talleres, rollout por olas
(3–4 talleres/semana). El backend entrega: mapeo campo a campo, scripts de import
(respetando la estructura multi-tenant / service_role), entorno de validación y
herramientas de validación por taller en el admin (`migration_validations`).

## Baseline del repo
Las 10 migraciones ya estaban **aplicadas en remoto** (se corrieron a mano antes de
existir el repo); se registraron con `migration repair --status applied`. De aquí en
adelante: `migration new` → editar → `db push`. El dashboard queda solo para verificar.

**Estado (2026-06):** `0012`–`0019` ya pasaron por el flujo normal (`migration new` → editar
→ `db push`) y están aplicadas en remoto. Local y remoto alineados hasta `0019`.

## Decisiones y aprendizajes (log vivo)
> Documenta el **porqué** de las decisiones de esquema y seguridad.
- `[2026-05]` Helpers de RLS en esquema `private` + `SECURITY DEFINER` para evitar
  recursión de políticas sobre `profiles`. El esquema queda oculto al rol authenticated.
- `[2026-05]` Generadores `apply_tenant_rls` / `apply_tenant_storage_rls` para no
  copiar políticas a mano en ~18 tablas/buckets.
- `[2026-05]` Stock calculado desde `inventory_movements` (vista `security_invoker`),
  nunca columna editable. Corrige el modelo de inventario roto de Zoho.
- `[2026-05]` Status Kanban / carga de técnicos / en proceso / entrega = vistas de
  `work_orders`, no tablas separadas.
- `[2026-05]` Flota/Empresa colapsado en `customers.is_fleet`; `fuel_type` corrige
  `tipo_vehiculo`.
- `[2026-05]` `technicians` modelados como staff, no usuarios de auth (la propuesta solo
  define roles antawa_admin y shop_owner).
- `[2026-05]` `webhook_events` agregado (fuera del ERD original) para idempotencia de
  webhooks de pago.
- `[2026-05]` Auth soporta contraseña **y** magic link (difiere de la propuesta firmada
  que era magic-link only; decisión del dev).
- `[2026-05]` Aislamiento multi-tenant verificado end-to-end (RLS en tablas, storage y
  vista) con `seed.sql` + `test_isolation.sql`.
- `[2026-06]` `quotes.quote_number`: correlativo POR taller vía contador en
  `private.shop_quote_counters` + trigger `BEFORE INSERT` con `ON CONFLICT DO UPDATE …
  RETURNING` (serializa por taller, sin advisory lock). Columna `NOT NULL DEFAULT 0`: el 0 es
  **sentinela** (el FE no manda número → el trigger lo asigna; y el `DEFAULT` hace que el tipo
  Insert generado lo marque opcional → `saveQuote` compila). Trigger **coalesce-aware**: un
  import service_role puede preservar un número explícito (ej. Zoho) y el contador avanza con
  `greatest()`. Huecos por rollback aceptables: una cotización NO es comprobante fiscal SRI
  (si algún día hay facturación, se rediseña gapless). Diseño vetado con doble-opus.
- `[2026-06]` Config del taller editable por el dueño vía RPC `update_shop_settings`
  (`SECURITY DEFINER`, allowlist name/logo_url/address) porque RLS no restringe por columna;
  la policy `shops_update` sigue admin-only.
- `[2026-06]` `shop-logos`: primer bucket **público** (logo en impresos), raster-only **sin
  SVG** (XSS cross-tenant en el render del admin), políticas de escritura a medida.
- `[2026-06]` `products.category` / `appointments.reason` = **texto libre** (sin tabla/enum):
  flexibilidad v1, normalizar es migración aditiva si hace falta. `appointment_source` gana
  `follow_up` (motivo de cita de seguimiento).
- `[2026-06]` `work_orders.quote_id` con **FK compuesto `(quote_id, shop_id)`** para garantizar
  tenancy (RLS no valida que un FK apunte al mismo taller). Backstop 1:1 cita↔cotización
  (`appointments.quote_id` unique parcial) aislado en `0019` por ser el único cambio con riesgo
  de datos; verificado 0 duplicados en remoto antes de aplicar.

## Qué evitar
- No editar migraciones ya aplicadas.
- No desactivar RLS "para que funcione rápido".
- No hacer cambios de schema directo en el dashboard de producción.
- No llamar `private.*` por nombre desde el front (lee `profiles`).
- No quitar `security_invoker` de `v_product_stock` (fuga de stock entre talleres).
- No crear tablas del ecosistema futuro (Driver, CarSOS, rewards) en V1.
- No exponer `service_role` al cliente.
- No agregar una columna de stock editable.
- No reemplazar el FK compuesto `(quote_id, shop_id)` de `work_orders` por uno simple
  (perdés la garantía de tenancy; RLS no la cubre).
- No permitir SVG en `shop-logos` (XSS en el render cross-tenant del admin).
- No sobrescribir-siempre `quote_number` en el trigger (rompe la preservación de números
  importados), ni quitarle el `DEFAULT 0` (el tipo Insert lo volvería requerido y rompe el FE).

## Fuera de alcance V1
Driver PWA, CarSOS, mecánicos móviles, botón de pánico, chatbot bidireccional de
WhatsApp, rewards/lealtad, seguros in-app, campañas de marketing, analítica profunda.

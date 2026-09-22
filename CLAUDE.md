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
- `technicians` = staff del taller, con **login opcional** vía `technicians.profile_id`
  (`0021`; nullable, unique parcial). El alta/revocación del login la hace la Edge
  Function `technician-access` (service_role); revocar = `deleteUser` → cascada borra
  el profile y el FK deja `profile_id` NULL (el historial queda, referencia `technicians.id`).
- `work_order_deliveries` 1:1 con la orden (cierre).
- `quote_items` apunta a `product_id` **o** `service_id` (nunca ambos).
- Roles: `antawa_admin` (sin shop), `shop_owner` (un shop) y `technician` (miembro de un
  shop; `0020`–`0022`: deny-by-default — `current_shop_id()` → NULL — más grants aditivos
  sobre SUS órdenes asignadas, bitácora/fotos, embeds y su fila de `technicians`).

Agregados lote 1–2 (`0012`–`0019`, 2026-06): `quotes.quote_number` (correlativo por taller,
ver log) + tabla interna `private.shop_quote_counters`; `shops.logo_url`/`address`;
`products.category` (texto libre); `appointment_source += follow_up`; `appointments.reason`
(texto libre); `work_orders.quote_id` (FK compuesto de tenancy); unique parcial
`appointments.quote_id` (1:1 cita↔cotización).

### Catálogo de trabajos (`0025`/`0026`/`0030`/`0031`/`0035`/`0039`)
Reemplaza el checklist manual de Zoho. Árbol **GLOBAL** `catalog_items` (módulos
`mantenimiento` / `reparacion` / `enderezada_pintura`; nodos `boolean` o `enum_select`,
self-FK compuesto `(parent_id, module)`, seed con UUIDs deterministas) + selecciones por
orden en `work_order_catalog_selections` (FK compuesto `(work_order_id, shop_id)`, `notes`
por nodo). Lectura para cualquier `authenticated`; **nadie edita el árbol desde la app**
(se siembra por migración / service_role). El técnico puede **escribir** las selecciones de
SUS órdenes (`0030`, aditivo).
`work_order_module_comments` (`0039`) agrega el **comentario libre por módulo** dentro de la
orden: una fila por `(work_order_id, module)` — un textarea, no un hilo — para lo que no está
en el menú y para importar los `Comentarios_Mantenimientos1` / `Comentarios_Reparaciones` de
Zoho 1:1. El FE lo muestra en el resumen como `  Comentarios: …` bajo los trabajos de ese
módulo. Mismo patrón de tenancy (FK compuesto + `apply_tenant_rls`) y mismo carve-out de
técnico que las selecciones.

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
El WhatsApp tiene **dos proveedores intercambiables por env** (`WHATSAPP_PROVIDER`:
`meta` por default, `twilio` como BSP) — mismo render y mismo `notification_log`,
cambia solo el transporte y su webhook de estados (`docs/whatsapp-twilio-setup.md`).

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
- `technician-access`: alta (invite por email / contraseña temporal) y revocación del
  login de un técnico, invocada por el owner desde la PWA. Auth in-code (JWT + rol
  shop_owner + tenancy del técnico); re-entrante con marker en `user_metadata`.
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
- `[2026-07]` Storage + `upsert: true` = `INSERT ... ON CONFLICT DO UPDATE`, y Postgres exige
  que la fila sea visible por una política **SELECT** — falla con violación de RLS AUNQUE no
  haya conflicto. `shop-logos` (0014, políticas separadas sin SELECT por ser bucket público)
  rompía TODOS los uploads de logo; `0028` agrega el SELECT scoped. Lección: toda política de
  escritura de storage que reciba upserts necesita su SELECT (o usar FOR ALL, como vehicle-media).
- `[2026-07]` `technician-access`: revocar el login es `auth.admin.deleteUser`, **no ban** —
  el esquema ya estaba diseñado para eso (cascada auth.users→profiles; `technicians.profile_id`
  on delete set null; los `created_by` set null). Con delete la RLS deniega al instante aunque
  el JWT viva (~1h): sin profile, `current_technician_id()` → NULL; un ban deja el JWT vivo
  pasando RLS hasta expirar. Alta re-entrante estilo provisionTenant: el user nace con marker
  `user_metadata {invited_as, technician_id, shop_id}`; un retry adopta huérfanos CON marker y
  jamás cuentas sin él (no secuestrar owners del funnel). Sin migración: todo corre con
  service_role sobre el esquema de `0020`–`0022`. El template de invite pasó a copy neutro
  (lo comparten dueño y técnico); replicarlo a mano en el Dashboard hosted al deployar.

- `[2026-09]` **Twilio como proveedor alternativo de WhatsApp** (`WHATSAPP_PROVIDER`,
  default `meta`): Meta factura contra la tarjeta de la WABA y el cobro rebotado dejó el
  canal a punto de cortarse; Twilio es BSP y factura él contra su propia línea con Meta.
  Se aisló lo del proveedor (`_shared/twilio.ts` + dos ramas en `whatsappTransport.ts`)
  igual que los proveedores de pago: el render, el dedupe, los reintentos y
  `notification_log` no se enteran. Dos detalles que mandan: (a) Twilio no acepta el
  NOMBRE de la plantilla sino su **Content SID** (`HX…`), así que el mapeo va en el secret
  `TWILIO_CONTENT_SIDS` y su ausencia corta ANTES de la red (un POST sin ContentSid
  quemaría los 5 intentos con el mismo 400); (b) el doble candado del dry-run mira las
  credenciales **del proveedor elegido**, para que un switch a medias quede en sandbox y
  no mande por Meta con la config incompleta. El asiento de los recibos de entrega se
  extrajo a `_shared/deliveryReceipts.ts` porque las dos reglas críticas (un fallo de
  ENTREGA no toca `status`; rank que nunca retrocede) tienen que valer igual para los dos
  webhooks. Firma de Twilio = HMAC-SHA1 sobre `url + params ordenados`, así que la URL
  pública tiene que ser **idéntica** a la registrada (`TWILIO_STATUS_CALLBACK_URL`).

- `[2026-09]` `work_order_module_comments` (`0039`) **revierte** la decisión de `0025` de no
  modelar el comentario general por módulo de Zoho ("vive en las notas de la orden/bitácora").
  Dos razones: producto lo pidió con forma propia (un textarea por menú, no una entrada más en
  la bitácora cronológica) y la migración de Zoho trae >1.000 comentarios libres por módulo que
  el importador no tenía dónde poner sin aplastarlos en un campo. Una fila por
  `(work_order_id, module)`, unique con **nombre explícito** (el FE traduce el 23505 y hace
  upsert con ese `onConflict`), `check` de no-vacío porque "sin comentario" = **borrar la fila**
  (si no, el resumen imprime un "Comentarios:" colgando). El técnico obtiene las 4 operaciones
  (no solo SELECT): es el mismo bloque de UI que los trabajos que ya puede editar desde `0030`.

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

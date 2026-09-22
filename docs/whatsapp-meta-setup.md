# WhatsApp (Meta Cloud API) + email — setup y encendido

> Referencia del trámite de aprobación de Meta + el contrato de plantillas y el
> "encendido" del lado técnico. El pipeline de notificaciones ya está construido en
> **modo sandbox (dry-run)** — RUNBOOK 3.8, migraciones `0023`/`0024`/`0034` + edge
> function `notification-dispatch`. Lo único que falta para enviar de verdad es la
> aprobación de Meta y pegar las credenciales. **El swap de sandbox → real es UN
> archivo por canal**: `_shared/whatsappTransport.ts` y `_shared/emailTransport.ts`.
>
> Desde 2026-08 el pipeline tiene **dos canales**: WhatsApp (los 6 eventos) y email
> (solo `quote_ready` y `vehicle_received`, ver "Canal email" abajo). Cada evento
> encola **una fila por canal** y el dedupe es por `(entidad, plantilla, canal)`
> (migración `0034`). Los flags `WHATSAPP_DRY_RUN` y `EMAIL_DRY_RUN` son
> **independientes**: se puede encender uno y dejar el otro en sandbox.
>
> **Desde 2026-09 el WhatsApp tiene DOS proveedores posibles** (`WHATSAPP_PROVIDER`,
> default `meta`): esta guía cubre el camino **Meta directo**; el alternativo por
> **Twilio** (BSP — factura él, para cuando el cobro de Meta traba la WABA) está en
> [`whatsapp-twilio-setup.md`](./whatsapp-twilio-setup.md). El contrato de las 6
> plantillas de este doc vale para los dos: Twilio pide re-crearlas en su Content
> Template Builder con **el mismo cuerpo carácter por carácter**.

## Estado

| Pieza | Estado |
|-------|--------|
| Encolado (barrido state-driven en los eventos del ciclo) | ✅ construido + verificado |
| Drenado + reintentos + render de plantillas | ✅ construido + verificado |
| Envío en dry-run (sandbox, no llama a Meta) | ✅ por defecto (`WHATSAPP_DRY_RUN=true`) |
| Cron (pg_cron + pg_net) | ✅ migración `0024` (no-op hasta configurar URL/secret) |
| Normalización de números a MSISDN (`_shared/phone.ts`) | ✅ construido (2026-07-30) |
| Acceso de Matias al portfolio "Antawa Tec" | ✅ invitación aceptada 2026-07-30 |
| WABA + número registrado (`+593 98 392 6448`, Phone ID `1064755926716530`) | ✅ conectado, calidad Alta |
| Las 6 plantillas | ✅ **APROBADAS** (verificado 2026-08-06) — ⚠️ pendientes de **re-editar** con la copy nueva (ver abajo) |
| Identidad del taller en el mensaje (firma + teléfono) | ✅ construido 2026-08 (`0032` + copy nueva) |
| Método de pago en la WABA `1644478160040571` | ✅ resuelto (2026-08) |
| Verificación del negocio | 🟡 **en curso** (no bloquea el arranque: el cap de 250 conv/día alcanza) |
| Publicar la app `1003852111528931` (sale de modo desarrollo) | ⛔ pendiente — falta URL de política de privacidad (va a `antwt.com`) |
| Envío REAL de WhatsApp (token + Phone Number ID) | ⛔ pendiente: System User + token + secrets |
| Canal email (Resend): render + transporte + encolado | ✅ construido 2026-08 (dry-run por defecto) |
| Correos de la orden con PDF adjunto (`vehicle_received` + `work_in_process` + `delivery_completed`) | ✅ construido 2026-09 (lote L2) — deploy con ventana, ver [`order-emails-deploy.md`](./order-emails-deploy.md) |
| Proveedor alternativo **Twilio** (transporte + `twilio-status-webhook`) | ✅ construido 2026-09, apagado por default (`WHATSAPP_PROVIDER=meta`) — falta registrar el sender y re-crear las 6 plantillas, ver [`whatsapp-twilio-setup.md`](./whatsapp-twilio-setup.md) |
| Envío REAL de email (`RESEND_API_KEY` + `EMAIL_DRY_RUN=false`) | ✅ encendido 2026-08-19; **funcionando recién desde 2026-08-28** (hasta entonces todo fallaba con 403 por el remitente en el apex, ver «Remitente») |

---

## Parte de Pablo (negocio) — iniciar el trámite

Ordenado por lo que más tarda (Meta revisa a mano; son días). **Empezar por el paso 1.**

### 1. Business Manager + Verificación del Negocio (el cuello de botella)
- Entrar a **business.facebook.com** con la cuenta de Antawa (o crear el portafolio).
- Iniciar la **Verificación del Negocio** (Centro de Seguridad → Verificación).
  Documentos típicos: **RUC / registro mercantil**, comprobante de dirección, razón
  social, teléfono y sitio web.

### 2. WhatsApp Business Account (WABA)
- Agregar el producto **WhatsApp** en Business Manager → crear la **WABA**.
- Asignar un **número de teléfono DEDICADO** (que **no** esté en uso en la app de
  WhatsApp / WhatsApp Business; si lo está, darlo de baja de la app primero). Debe
  poder recibir SMS o llamada para el código de verificación.
- Definir el **nombre para mostrar** (lo que ve el cliente como remitente). Meta lo revisa.

### 3. Registrar las 6 plantillas — categoría **Utility**, idioma **Español (es)**
Usar **exactamente** estos nombres y textos (ver el contrato más abajo — deben coincidir
con el código, si no, el envío falla).

### 4. App + credenciales (con el dev, ~15 min)
- Crear una **app** en developers.facebook.com (tipo *Business*) conectada a la WABA.
- **Token permanente** vía System User (permisos `whatsapp_business_messaging` +
  `whatsapp_business_management`).
- Anotar **Phone Number ID** y **WABA ID**.

### 5. Método de pago en la WABA
- Meta cobra por conversación pasado el tramo gratis.

**Entregar al dev:** token permanente · Phone Number ID · WABA ID · confirmación de
plantillas aprobadas.

---

## Contrato de plantillas (DEBE coincidir con el código)

El código envía `template.name` = el nombre del enum (abajo) e idioma `es`, con las
variables como **parámetros posicionales de body** (`components[].body`). El orden de
`{{1}}, {{2}}, {{3}}, {{4}}` lo fija `renderTemplate()` en
`supabase/functions/_shared/notificationTemplates.ts` (campo `components`).

> ### Tres reglas de Meta que condicionan la redacción
> Las dos primeras se descubrieron al registrar las plantillas el **2026-07-30** — el
> contrato original las violaba y **no era registrable**:
> 1. Una plantilla **no puede empezar con variable** → de ahí el prefijo `Hola `.
> 2. Tampoco puede **terminar con variable**, y un punto final **no alcanza**: hace
>    falta texto real después → de ahí el **AVISO fijo** al cierre de las 6.
> 3. Los **parámetros** no pueden llevar saltos de línea, tabs ni 4+ espacios
>    seguidos. El **cuerpo** de la plantilla **sí** puede ser multilínea: la
>    restricción es sobre las variables, no sobre el texto fijo. El código colapsa el
>    whitespace de *todos* los parámetros (`collapseParam()`), porque todos salen de
>    texto tipeado a mano en la PWA.

### Por qué el aviso va en el CUERPO y no en el footer

No hay chatbot ni bandeja de entrada (solo salida, CLAUDE.md): si el cliente responde
un WhatsApp, no lo lee nadie. El aviso lo escribió Pablo y mide ~101 caracteres — el
**footer** de Meta topea en **60**, así que no entra. Va como última línea del body,
que además resuelve la regla 2 (ninguna plantilla termina en variable) y mejora el
ratio variables/texto fijo que Meta evalúa. **Las plantillas no llevan footer.**

AVISO (idéntico en las 6):
`Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.`

### La firma es UNA variable compuesta en código

Los ~18 talleres comparten UNA WABA, UN número y UN juego de plantillas: el remitente
es genérico y no puede variar por taller. La identidad viaja entonces en el contenido,
como última variable del body:

- con teléfono cargado → `Taller Pablo · Tel. 0998765432`
- sin teléfono → `Taller Pablo`
- payload viejo sin taller → `Tu taller de confianza` (fallback)

Componer la firma en código (`signatureLine()`) en vez de usar dos variables resuelve
que `shops.contact_phone` sea opcional sin bifurcar la plantilla. El teléfono lo edita
el dueño en /configuración (RPC `update_shop_settings`, migración `0032`).

### Los 6 cuerpos (`⏎` = salto de línea real; entre párrafos va UNA línea en blanco)

| Nombre (exacto) | Body | Variables |
|---|---|---|
| `appointment_confirmed` | `Hola {{1}}, tu cita de servicio para tu vehículo {{2}} quedó confirmada para el {{3}}.`<br><br>`Te esperamos,`<br><br>`{{4}}`<br><br>*AVISO* | 1 cliente · 2 vehículo · 3 fecha/hora · 4 firma |
| `appointment_reminder_24h` | `Hola {{1}}, te recordamos tu cita para tu vehículo {{2}} mañana {{3}}.`<br><br>`Te esperamos,`<br><br>`{{4}}`<br><br>*AVISO* | 1 cliente · 2 vehículo · 3 fecha/hora · 4 firma |
| `vehicle_received` | `Hola {{1}}, hemos recibido tu vehículo {{2}} en el taller. Te avisamos cuando esté listo.`<br><br>`Atentamente,`<br><br>`{{3}}`<br><br>*AVISO* | 1 cliente · 2 vehículo · 3 firma |
| `quote_ready` | `Hola {{1}}, la cotización para tu vehículo {{2}} está lista para tu revisión.`<br><br>`{{3}}`<br><br>`Atentamente,`<br><br>`{{4}}`<br><br>*AVISO* | 1 cliente · 2 vehículo · 3 resumen · 4 firma |
| `vehicle_ready` | `Hola {{1}}, tu vehículo {{2}} ya está listo para retirar.`<br><br>`Atentamente,`<br><br>`{{3}}`<br><br>*AVISO* | 1 cliente · 2 vehículo · 3 firma |
| `delivery_completed` | `Hola {{1}}, entregamos tu vehículo {{2}}. Resumen del servicio: {{3}}.`<br><br>`¡Gracias por confiar en nosotros!`<br><br>`{{4}}`<br><br>*AVISO* | 1 cliente · 2 vehículo · 3 resumen · 4 firma |

**Cuerpos exactos para pegar en el editor de Meta** (copiar el bloque de cada una tal
cual, aviso incluido):

```
appointment_confirmed
Hola {{1}}, tu cita de servicio para tu vehículo {{2}} quedó confirmada para el {{3}}.

Te esperamos,

{{4}}

Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.
```
```
appointment_reminder_24h
Hola {{1}}, te recordamos tu cita para tu vehículo {{2}} mañana {{3}}.

Te esperamos,

{{4}}

Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.
```
```
vehicle_received
Hola {{1}}, hemos recibido tu vehículo {{2}} en el taller. Te avisamos cuando esté listo.

Atentamente,

{{3}}

Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.
```
```
quote_ready
Hola {{1}}, la cotización para tu vehículo {{2}} está lista para tu revisión.

{{3}}

Atentamente,

{{4}}

Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.
```
```
vehicle_ready
Hola {{1}}, tu vehículo {{2}} ya está listo para retirar.

Atentamente,

{{3}}

Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.
```
```
delivery_completed
Hola {{1}}, entregamos tu vehículo {{2}}. Resumen del servicio: {{3}}.

¡Gracias por confiar en nosotros!

{{4}}

Por favor no respondas a este mensaje, cualquier inquietud comunicarse con el administrador del taller.
```

**Valores de ejemplo** para el editor de Meta (los pide para previsualizar; no son
parte del contrato, pero conviene que se parezcan a lo real):

| Variable | Ejemplo |
|---|---|
| cliente | `Andrés` |
| vehículo | `Chevrolet Aveo PBX-1234` |
| fecha/hora | `2026-08-20 09:00` |
| resumen (cotización) | `Cambio de aceite, Filtro de aire — Total: $54,05` |
| resumen (entrega) | `Cambio de aceite; Revisión de frenos` |
| firma | `Taller AntawaTec · Tel. 0998765432` |

*(El monto sale con coma decimal: el código formatea en `es-EC`, igual que la PWA.)*
⚠️ Mantener **una sola línea en blanco** entre párrafos: el editor rechaza saltos
excesivos.

**Registradas el 2026-07-30** en la WABA `1644478160040571`, idioma **Spanish (`es`)**,
categoría **Servicio (Utility)**; aprobadas el 2026-08-06.
⚠️ `vehicle_received` quedó por error en categoría **Marketing** y tras la aprobación
**sigue en Marketing** (verificado 2026-08-06). La UI del Administrador de WhatsApp NO
permite editar la categoría (etiqueta fija en el editor). Corregirla vía Graph API con el
token del System User (`whatsapp_business_management`):
`POST https://graph.facebook.com/v21.0/1063928546306209` body `{"category":"UTILITY"}`
(ese id es el template id de `vehicle_received`; vuelve a revisión unos minutos).
**NO borrar la plantilla**: un nombre borrado queda bloqueado 30 días.

Si se cambia el texto de una plantilla en Meta, hay que reflejarlo en
`notificationTemplates.ts` (y viceversa) — son las dos mitades del mismo contrato.

---

## Editar plantillas aprobadas (leer ANTES de tocar el editor)

La copy nueva (firma + aviso) llega a plantillas **ya aprobadas**, así que hay que
editarlas. Reglas del juego:

- **EDITAR, nunca borrar.** Borrar una plantilla **bloquea su nombre 30 días**, y el
  nombre es el contrato con el código (`template.name` = valor del enum
  `notification_template`). Una plantilla borrada por error deja el evento muerto un mes.
- **Editar la manda a *In Review*.** Mientras está en revisión **no se puede enviar**
  con ella. Por eso esto se hace **ahora, en dry-run**: costo cero. Hacerlo después del
  encendido frena el pipeline en seco.
- **Límites por plantilla:** **1 edición por día** y **10 cada 30 días**. Se cuentan por
  plantilla, no por WABA.
- **Secuencia con la corrección de categoría:** la recategorización
  Marketing→Utility de `vehicle_received` (Graph API, arriba) cuenta contra el **mismo
  límite diario** que la edición de su cuerpo. Hacerlas en **días distintos** o una de
  las dos falla.
- Tras re-aprobarse, verificar que el texto en Meta y el `text` que produce
  `renderTemplate()` coinciden **carácter por carácter**, saltos incluidos.

---

## Canal email (Resend)

Segundo canal del mismo pipeline: mismo barrido, mismo `notification_log`, mismo
reintento. Lo que cambia es el render (`_shared/emailTemplates.ts`) y el transporte
(`_shared/emailTransport.ts`).

**Alcance — cuatro eventos** (los dos primeros desde 2026-08; los dos con PDF, desde
el lote L2). El correo existe para llevar lo que el WhatsApp no puede: el **desglose
con precios** y los **documentos adjuntos**. Los tres restantes (las dos de citas y
`vehicle_ready`) son avisos cortos y siguen whatsapp-only (`renderEmail()` devuelve
`null` para ellos).

| Evento | Asunto | Contenido |
|---|---|---|
| `quote_ready` | `Cotización N° 0042 — <taller>` | Encabezado con logo/nombre/dirección/teléfono del taller, vehículo, una tabla por sección (`Mantenimiento y Reparación` / `Enderezada y Pintura`) con ítems, cantidad, precio unitario y total de línea, y el bloque subtotal / IVA / total. |
| `vehicle_received` | `Recibimos tu vehículo — <taller>` | Confirmación de recepción + **ORDEN DE TRABAJO EN PDF ADJUNTA** (`OT-0042-orden.pdf`). Si la orden nace de una cotización (`work_orders.quote_id`), suma el desglose de los trabajos acordados. Sale **15 min después** de crearse la orden (HOLD, ver abajo). |
| `work_in_process` | `Tu vehículo está en proceso — <taller>` | Aviso corto de que el trabajo arrancó. **EMAIL-ONLY** (no hay plantilla de WhatsApp) y **sin adjunto**. |
| `delivery_completed` | `Recibo de entrega — <taller>` | **RECIBO DE ENTREGA EN PDF ADJUNTO** (`OT-0042-recibo.pdf`) + el resumen de trabajos como lista. |

**Los adjuntos.** Se generan server-side con `npm:pdf-lib` (`_shared/orderPdf.ts`)
leyendo la orden **fresca** de la base (`_shared/orderSnapshot.ts`), no el snapshot
del payload: estos documentos son el ACTA de la orden, no el aviso. Son el espejo
exacto de las vistas imprimibles del FE (`OrderPrintView` / `DeliveryReceiptView`) —
cambiar el texto de una obliga a cambiar la otra. De ahí dos reglas del drenado:

- **HOLD de 15 min** para `(vehicle_received, email)`: la orden se crea vacía y el
  taller carga km, checklist, trabajos y repuestos después. La fila espera en
  `queued` **sin consumir intentos**.
- **`PDF_PER_TICK`**: tope de PDFs por corrida del cron; lo que sobra queda `queued`
  para el próximo tick. La respuesta de la función trae `held` y `deferred` para
  distinguir "esperando" de "trabado".

El PDF además se archiva (best-effort) en el bucket privado `pdfs` bajo
`{shop_id}/orders/{work_order_id}/`, y el recibo escribe
`work_order_deliveries.delivery_pdf_url`. **Un fallo del archivado NUNCA cambia
`status`** (marcar `failed` reenviaría un correo ya entregado).

⚠️ **Estrenar un par (plantilla, canal) exige backfill.** El barrido es
state-driven y sin ventana temporal: sin filas sembradas, el primer tick le manda el
evento a TODO el histórico. Ver `supabase/migrations/0041_*.sql` y el runbook
[`order-emails-deploy.md`](./order-emails-deploy.md).

**Remitente y respuestas.** El dominio verificado en Resend es uno solo y es el
**subdominio `mail.antwt.com`** (el apex `antwt.com` **no** está verificado — es el mismo
gotcha del SMTP de Auth: con `@antwt.com` Resend devuelve `403 The antwt.com domain is not
verified`, la fila consume sus 5 intentos y queda `failed` para siempre). Lo comparten todos
los talleres, así que la identidad va en el **display name**:
`Taller Pablo <notificaciones@mail.antwt.com>`. Además se manda **`reply_to` =
`shops.contact_email`** cuando existe: la casilla del remitente **no se monitorea**, y
sin reply-to el cliente que responde le escribe al vacío. (Esta es la diferencia con
WhatsApp, donde el canal es explícitamente de una vía.)

**Snapshot al encolar.** El correo congela la cotización en el momento del envío: editar
la cotización después **no** cambia lo ya encolado. El desglose viaja en
`notification_log.payload.quote`.

**Cliente sin email → la fila se encola igual y falla.** Es deliberado: si no se
encolara, no habría fila de dedupe y cargarle el email al cliente meses después
dispararía un "Recibimos tu vehículo" de una orden vieja. Encolar congela el evento —
5 intentos fallan determinísticos y queda `failed` con el error `cliente sin email`,
auditable.

**Secrets** (función `notification-dispatch`):
- `EMAIL_DRY_RUN` — default `true`. **No hace falta setearlo** para quedar en sandbox.
- `RESEND_API_KEY` — sin ella el transporte se queda en dry-run aunque el flag esté en
  `false` (misma lógica de doble candado que WhatsApp).
- `EMAIL_FROM` — opcional, default `notificaciones@mail.antwt.com`. Si se setea, **tiene que
  ser `@mail.antwt.com`** (o de otro dominio verificado en la cuenta Resend `antwt`).

```
supabase secrets set RESEND_API_KEY=re_...
# y recién cuando se quiera enviar de verdad:
supabase secrets set EMAIL_DRY_RUN=false
```

**Limitación v1 conocida:** el dedupe hace imposible **re-enviar** una cotización al
cliente (una fila por evento y canal). Workaround operativo: borrar la fila de
`notification_log` correspondiente.

---

## Parte del dev — encender (cuando lleguen las credenciales)

> ### ⚠️ Paso 0 OBLIGATORIO: absorber el backlog en dry-run — EN LOS DOS CANALES
>
> `sweep()` es **state-driven sin ventana temporal**: encola `vehicle_received` para
> *toda* orden que exista, `vehicle_ready` para toda orden en `delivery`/`historical`,
> `delivery_completed` para toda `historical` y `appointment_confirmed` para toda cita
> con `source='quote'`. Si se prende el envío real con `notification_log` vacío, el
> primer tick le manda a clientes reales una notificación por cada evento histórico.
>
> Medido en prod el **2026-07-30**: `notification_log` = 0 filas y el backlog daba
> **49 mensajes** (23 + 10 + 8 + 8) sobre 18 clientes.
>
> **El backlog ahora es de dos canales.** A esos 49 de WhatsApp se suma el backlog de
> **email de `vehicle_received`**: una fila por orden existente (las 23 de la medición),
> las que tengan `quote_id` con el desglose adjunto. `quote_ready` **no** trae backlog
> histórico: `quotes.sent_at` (migración `0033`) nace NULL en todas las filas, así que
> solo se disparan las cotizaciones que el dueño envíe de ahora en más.
>
> **Antes** de tocar `WHATSAPP_DRY_RUN` o `EMAIL_DRY_RUN`, con **ambos flags todavía en
> `true`**, invocar `notification-dispatch` a mano y repetir hasta que devuelva
> `enqueued: 0, sent: 0` (el drenado va de a `DRAIN_LIMIT=100`). Eso marca el histórico
> como `sent` con `dry_run:true`, y el índice único de `0034` impide que se vuelva a
> encolar: al encender solo salen los eventos **nuevos**.
>
> Como los flags son independientes, se puede encender un canal y dejar el otro en
> sandbox — pero la absorción hay que hacerla igual para los dos, porque el barrido
> encola las filas de ambos canales sin mirar los flags.
>
> Aprovechar esa corrida para revisar las filas `failed`: son los números que
> `toWhatsAppMsisdn()` no pudo normalizar (ver abajo) y los clientes sin email o con
> email inválido. Hay que corregirlos a mano.

### Números de teléfono

`_shared/phone.ts` normaliza a MSISDN (`593XXXXXXXXX`) antes de llamar a Meta, que
rechaza cualquier otro formato. La auditoría de prod del 2026-07-30 sobre 18 clientes
encontró **9** ya en `+593…`, **4** en local `09…`, **3** móviles pelados `9…` y **2**
irrecuperables (uno de 8 dígitos, uno con el 0 troncal duplicado tras el país) que
necesitan corrección manual. El front (`normalizeEcMobile` en `src/lib/format.ts`)
valida y guarda ya normalizado, así que el problema no vuelve a entrar por el alta.

1. **Secrets de la función** `notification-dispatch`:
   - `WHATSAPP_DRY_RUN=false`
   - `WHATSAPP_TOKEN=<token permanente>`
   - `WHATSAPP_PHONE_ID=<Phone Number ID>`
   - `CRON_SECRET=<secret fuerte>` (auth del invocador del cron)
   - `RESEND_API_KEY=<key>` (+ `EMAIL_DRY_RUN=false` para encender el email)
   ```
   supabase secrets set WHATSAPP_DRY_RUN=false WHATSAPP_TOKEN=... WHATSAPP_PHONE_ID=... CRON_SECRET=...
   ```
2. **Settings del cron** (para que `0024` deje de ser no-op):
   ```sql
   alter database postgres set app.notification_dispatch_url =
     'https://<project-ref>.functions.supabase.co/notification-dispatch';
   alter database postgres set app.cron_secret = '<el mismo CRON_SECRET>';
   ```
3. **Deploy**: `supabase functions deploy notification-dispatch` + `supabase db push`
   (migraciones `0023`/`0024`/`0032`/`0033`/`0034`). Regenerar tipos en el FE
   (`npm run gen:types`).
   ⚠️ `0034` y el `onConflict` de la función son **dos mitades del mismo cambio**: entre
   el `db push` y el `functions deploy` el barrido devuelve 500 (el onConflict viejo de
   3 columnas no encuentra índice). Es inofensivo — el cron reintenta y el barrido es
   state-driven, no pierde eventos — pero **deployar la función en la misma sesión**.
   Antes del push, chequeo read-only de sanidad:
   `select channel, template, status, count(*) from notification_log group by 1,2,3;`
4. **Validar** con un número/email propio: que `whatsappTransport.ts` ya **no** sea
   dry-run (no marca `payload.dry_run`) y que la fila de `notification_log` pase a `sent`
   tras un envío real. Los únicos archivos que cambian de comportamiento son los dos
   transports (rama real vs dry-run); el resto del pipeline es idéntico al sandbox ya
   probado.

## Diferido (no bloquea el envío)
- **Webhook de estado de Meta** (delivered → `read`) + valor `read` en el enum.
- Email para los 3 eventos restantes (citas × 2 y `vehicle_ready`): whatsapp-only por diseño.
- PDF adjunto en el correo de **cotización** (hoy va el desglose en HTML; la
  maquinaria de adjuntos ya existe desde el lote L2, falta el renderer).
- Re-enviar una cotización ya enviada (bloqueado por el dedupe; ver "Canal email").

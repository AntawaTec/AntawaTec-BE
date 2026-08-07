# WhatsApp (Meta Cloud API) — setup y encendido

> Referencia del trámite de aprobación de Meta + el contrato de plantillas y el
> "encendido" del lado técnico. El pipeline de notificaciones ya está construido en
> **modo sandbox (dry-run)** — RUNBOOK 3.8, migraciones `0023`/`0024` + edge function
> `notification-dispatch`. Lo único que falta para enviar de verdad es la aprobación
> de Meta y pegar las credenciales. **El swap de sandbox → real es UN archivo**
> (`supabase/functions/_shared/whatsappTransport.ts`).

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
| Las 6 plantillas | ✅ **APROBADAS** (verificado 2026-08-06) — ⚠️ `vehicle_received` sigue en Marketing, ver nota abajo |
| Método de pago en la WABA `1644478160040571` | ✅ resuelto (2026-08) |
| Verificación del negocio | 🟡 **en curso** (no bloquea el arranque: el cap de 250 conv/día alcanza) |
| Publicar la app `1003852111528931` (sale de modo desarrollo) | ⛔ pendiente — falta URL de política de privacidad (va a `antwt.com`) |
| Envío REAL (token + Phone Number ID) | ⛔ pendiente: System User + token + secrets |

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
`{{1}}, {{2}}, {{3}}` lo fija `renderTemplate()` en
`supabase/functions/_shared/notificationTemplates.ts` (campo `components`).

> ### Dos reglas de Meta que condicionan la redacción
> Descubiertas al registrar las plantillas el **2026-07-30** — el contrato original
> las violaba y **no era registrable**:
> 1. Una plantilla **no puede empezar con variable** → de ahí el prefijo `Hola `.
> 2. Tampoco puede **terminar con variable**, y un punto final **no alcanza**: hace
>    falta texto real después → de ahí `Te esperamos.` y `¡Gracias por confiar en nosotros!`.

| Nombre (exacto) | Texto (body) | `{{1}}` | `{{2}}` | `{{3}}` |
|---|---|---|---|---|
| `appointment_confirmed` | `Hola {{1}}, tu cita para {{2}} quedó confirmada para el {{3}}. Te esperamos.` | cliente | vehículo | fecha/hora |
| `appointment_reminder_24h` | `Hola {{1}}, te recordamos tu cita para {{2}} mañana {{3}}. Te esperamos.` | cliente | vehículo | fecha/hora |
| `vehicle_received` | `Hola {{1}}, recibimos {{2}} en el taller. Te avisamos cuando esté listo.` | cliente | vehículo | — |
| `vehicle_ready` | `Hola {{1}}, {{2}} ya está listo para retirar.` | cliente | vehículo | — |
| `delivery_completed` | `Hola {{1}}, entregamos {{2}}. Resumen del servicio: {{3}}. ¡Gracias por confiar en nosotros!` | cliente | vehículo | resumen |
| `quote_ready` | `Hola {{1}}, la cotización para {{2}} está lista para tu revisión.` | cliente | vehículo | — |

**Registradas el 2026-07-30** en la WABA `1644478160040571`, idioma **Spanish (`es`)**,
categoría **Servicio (Utility)** — todas en estado *En revisión*.
⚠️ `vehicle_received` quedó por error en categoría **Marketing** y tras la aprobación
**sigue en Marketing** (verificado 2026-08-06). La UI del Administrador de WhatsApp NO
permite editar la categoría (etiqueta fija en el editor). Corregirla vía Graph API con el
token del System User (`whatsapp_business_management`):
`POST https://graph.facebook.com/v21.0/1063928546306209` body `{"category":"UTILITY"}`
(ese id es el template id de `vehicle_received`; vuelve a revisión unos minutos).
**NO borrar la plantilla**: un nombre borrado queda bloqueado 30 días.

> Nota: `quote_ready` tiene su render listo pero **aún no se dispara** (el evento
> "enviar cotización al cliente" no existe todavía en el producto). Registrar la
> plantilla ahora no hace daño y la deja lista.

Si se cambia el texto de una plantilla en Meta, hay que reflejarlo en
`notificationTemplates.ts` (y viceversa) — son las dos mitades del mismo contrato.

---

## Parte del dev — encender (cuando lleguen las credenciales)

> ### ⚠️ Paso 0 OBLIGATORIO: absorber el backlog en dry-run
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
> **Antes** de tocar `WHATSAPP_DRY_RUN`, con el flag todavía en `true`, invocar
> `notification-dispatch` a mano y repetir hasta que devuelva `enqueued: 0, sent: 0`
> (el drenado va de a `DRAIN_LIMIT=100`). Eso marca el histórico como `sent` con
> `dry_run:true`, y el índice único de `0023` impide que se vuelva a encolar: al
> encender solo salen los eventos **nuevos**.
>
> Aprovechar esa corrida para revisar las filas `failed` — son los números que
> `toWhatsAppMsisdn()` no pudo normalizar (ver abajo) y hay que corregir a mano.

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
   (migraciones `0023`/`0024`). Regenerar tipos en el FE (`npm run gen:types`).
4. **Validar** con un número propio: que `whatsappTransport.ts` ya **no** sea dry-run
   (no marca `payload.dry_run`) y que la fila de `notification_log` pase a `sent` tras
   un envío real. El único archivo que cambió de comportamiento es `whatsappTransport.ts`
   (rama real vs dry-run); el resto del pipeline es idéntico al sandbox ya probado.

## Diferido (no bloquea el envío de WhatsApp)
- **Email (Resend) como fallback** + valor `fallback` en el enum `notification_status`.
- **Webhook de estado de Meta** (delivered → `read`) + valor `read` en el enum.
- Disparo de `quote_ready` cuando exista el evento de "enviar cotización".

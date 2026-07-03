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
| **Aprobación de Meta (Business Verification + WABA + plantillas)** | ⛔ **pendiente — lo inicia Antawa (Pablo)** |
| Envío REAL (token + Phone Number ID) | ⛔ pendiente de lo anterior |

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

| Nombre (exacto) | Texto (body) | `{{1}}` | `{{2}}` | `{{3}}` |
|---|---|---|---|---|
| `appointment_confirmed` | `{{1}}, tu cita para {{2}} quedó confirmada para el {{3}}.` | cliente | vehículo | fecha/hora |
| `appointment_reminder_24h` | `{{1}}, te recordamos tu cita para {{2}} mañana, {{3}}.` | cliente | vehículo | fecha/hora |
| `vehicle_received` | `{{1}}, recibimos {{2}} en el taller. Te avisamos cuando esté listo.` | cliente | vehículo | — |
| `vehicle_ready` | `{{1}}, {{2}} ya está listo para retirar.` | cliente | vehículo | — |
| `delivery_completed` | `{{1}}, gracias por confiar en nosotros. Entregamos {{2}}. Resumen: {{3}}.` | cliente | vehículo | resumen |
| `quote_ready` | `{{1}}, la cotización para {{2}} está lista para tu revisión.` | cliente | vehículo | — |

> Nota: `quote_ready` tiene su render listo pero **aún no se dispara** (el evento
> "enviar cotización al cliente" no existe todavía en el producto). Registrar la
> plantilla ahora no hace daño y la deja lista.

Si se cambia el texto de una plantilla en Meta, hay que reflejarlo en
`notificationTemplates.ts` (y viceversa) — son las dos mitades del mismo contrato.

---

## Parte del dev — encender (cuando lleguen las credenciales)

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

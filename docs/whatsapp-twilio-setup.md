# WhatsApp por Twilio — proveedor alternativo (setup y switch)

> Complemento de [`whatsapp-meta-setup.md`](./whatsapp-meta-setup.md). **Todo lo de
> ese doc sigue valiendo**: el pipeline (encolado, dedupe, reintentos, render,
> `notification_log`) es el mismo, el contrato de las 6 plantillas es el mismo y la
> absorción del backlog en dry-run sigue siendo obligatoria. Lo único que cambia es
> **quién pone el cable**: Meta directo o Twilio como BSP.

## Por qué existe esta rama

La WABA de la app quedó **restringida por falta de pago**: Meta cobra contra una
tarjeta cargada en la cuenta publicitaria y el cargo venía rebotando, con el canal
a punto de cortarse (y la WABA de Zoho ya muerta por lo mismo). **Twilio es un
Business Solution Provider**: factura él contra su propia línea de crédito con
Meta y nos cobra a nosotros, así que el canal deja de depender de que ese cobro
puntual entre. El costo por conversación es el de Meta + el markup de Twilio.

Es una **alternativa seleccionable por env**, no un reemplazo: el camino Meta
queda intacto y es el default.

| | Meta (default) | Twilio |
|---|---|---|
| `WHATSAPP_PROVIDER` | `meta` (o sin setear) | `twilio` |
| Identifica la plantilla por | **nombre** (`quote_ready`) | **Content SID** (`HX…`) |
| Id del mensaje (`provider_message_id`) | `wamid.…` | `SM…` |
| Webhook de estados | `whatsapp-webhook` (HMAC-SHA256 del body crudo) | `twilio-status-webhook` (HMAC-SHA1 de url+params) |
| Quién factura | Meta, contra la tarjeta de la WABA | Twilio, contra su cuenta |

**Lo que NO cambia:** `notificationTemplates.ts` (mismo render, mismos
`components`), el `notification_log`, el cron, el dedupe, los reintentos y la regla
de que un fallo de **entrega** nunca toca `status` (ver
`_shared/deliveryReceipts.ts`).

---

## Parte de negocio — registrar el sender

### 1. Self sign-up del sender de WhatsApp
Console de Twilio → **Messaging → Senders → WhatsApp senders → Get Started**
(*Numbers & senders*). El flujo pide:

- Una cuenta de **Meta Business Manager** (portafolio) con la que se vincula el
  sender. Si Antawa ya tiene el portafolio del trámite de Meta, se reusa: no hace
  falta crear otro.
- Un **número de teléfono** que pueda recibir el **código OTP** (SMS o llamada)
  para la verificación.
- **Display name** (lo que ve el cliente) y categoría del negocio. Meta lo revisa
  igual que en el camino directo.

> ⚠️ **Migrar un número que ya está en una WABA** (por ejemplo el
> `+593 98 392 6448` de la WABA actual) exige **desactivar la verificación en dos
> pasos** de ese número en WhatsApp Manager **antes** de empezar la migración; si
> no, el paso del OTP falla. Y mientras el número está migrando **no se puede
> enviar por ninguno de los dos caminos**: es la parte de la ventana que hay que
> coordinar con el taller. Registrar un número **nuevo** evita ese corte, a costa
> de que el cliente vea otro remitente.

### 2. Las 6 plantillas en el Content Template Builder
Twilio **no** reusa las plantillas aprobadas en Meta: hay que crearlas en su
Content Template Builder (Console → **Content Template Builder → Create new**) y
mandarlas a aprobación de WhatsApp desde ahí.

Para cada una de las 6:

- **Content type:** `twilio/text` (las nuestras son texto puro, sin botones ni media).
- **Language:** `es` (Spanish).
- **Category (WhatsApp):** `UTILITY`. ⚠️ En Meta `vehicle_received` quedó por error
  en *Marketing* y no se pudo corregir por UI — acá es la oportunidad de dejar las
  **6 en UTILITY** desde el principio.
- **Body:** el mismo cuerpo **carácter por carácter** que produce
  `notificationTemplates.ts`, aviso final incluido. Los bloques listos para pegar
  están en [`whatsapp-meta-setup.md`](./whatsapp-meta-setup.md), sección *"Cuerpos
  exactos para pegar en el editor de Meta"*; Twilio usa la misma notación `{{1}}`,
  `{{2}}`, … que Meta, así que se copian tal cual.
- **Variables:** posicionales `{{1}}`…`{{4}}` — el **orden lo fija el array
  `components` del render**, no la plantilla. Ver la tabla de contrato abajo.

Al aprobarse, cada plantilla queda con un **Content SID** (`HX…`). Esos 6 SIDs son
lo que hay que entregarle al dev.

### Contrato de las 6 plantillas (nombre → variables)

El nombre es el valor del enum `notification_template` y es la llave del mapa
`TWILIO_CONTENT_SIDS`. Los significados de cada variable son los de la tabla de
`whatsapp-meta-setup.md`.

| Plantilla | Variables | Orden (`components`) |
|---|---|---|
| `appointment_confirmed` | **4** | 1 cliente · 2 vehículo · 3 fecha/hora · 4 firma |
| `appointment_reminder_24h` | **4** | 1 cliente · 2 vehículo · 3 fecha/hora · 4 firma |
| `vehicle_received` | **3** | 1 cliente · 2 vehículo · 3 firma |
| `quote_ready` | **4** | 1 cliente · 2 vehículo · 3 resumen · 4 firma |
| `vehicle_ready` | **3** | 1 cliente · 2 vehículo · 3 firma |
| `delivery_completed` | **4** | 1 cliente · 2 vehículo · 3 resumen · 4 firma |

El transporte manda `ContentVariables` como JSON **1-based**
(`{"1":…,"2":…,"3":…}`) en el mismo orden del array `components`. Si una plantilla
se registra con las variables en otro orden, el cliente recibe el nombre donde va
la placa: el orden es contrato, no detalle.

**Entregar al dev:** Account SID · Auth Token · número del sender · los 6 Content SIDs.

---

## Parte del dev — configurar

### Secrets (Dashboard de Supabase → Edge Functions → Secrets)

> `supabase secrets set` viene fallando por el keyring del token (ver memoria del
> proyecto): cargarlos por **Dashboard**. Nunca commitear valores reales — el repo
> solo lleva los nombres, en `supabase/functions/.env.example`.

| Secret | Valor |
|---|---|
| `WHATSAPP_PROVIDER` | `twilio` |
| `TWILIO_ACCOUNT_SID` | `AC…` (Console → Account Info) |
| `TWILIO_AUTH_TOKEN` | el auth token de la cuenta — **también** valida la firma del webhook |
| `TWILIO_WHATSAPP_FROM` | el número del sender en E.164, con o sin prefijo (`whatsapp:+593…` o `+593…`) |
| `TWILIO_CONTENT_SIDS` | JSON `{"appointment_confirmed":"HX…","appointment_reminder_24h":"HX…","vehicle_received":"HX…","quote_ready":"HX…","vehicle_ready":"HX…","delivery_completed":"HX…"}` |
| `TWILIO_STATUS_CALLBACK_URL` | `https://<project-ref>.functions.supabase.co/twilio-status-webhook` (opcional pero recomendado) |

**Doble candado, igual que en Meta:** el transporte sale de dry-run solo si
`WHATSAPP_DRY_RUN=false` **y** están las 4 credenciales de Twilio
(`ACCOUNT_SID`, `AUTH_TOKEN`, `WHATSAPP_FROM`, `CONTENT_SIDS`). Poner
`WHATSAPP_PROVIDER=twilio` sin los secrets deja el canal en **sandbox** — no
manda por Meta a espaldas de la config ni revienta el drenado.

Si falta el Content SID de una plantilla, ese evento falla **antes de tocar la
red** con `twilio: sin ContentSid para <plantilla>` en `notification_log.error`
(un POST sin `ContentSid` gastaría los 5 intentos volviendo con el mismo 400).

### Status callback (recibos de entrega)

`twilio-status-webhook` es el gemelo de `whatsapp-webhook` y asienta lo mismo:
`provider_status`, `delivered_at`, `read_at` y el motivo del fallo, por
`provider_message_id` (el `SM…`).

1. Deploy: `supabase functions deploy twilio-status-webhook`
   (`verify_jwt = false` ya está declarado en `config.toml`).
2. Pegar la URL en Twilio: Console → **Messaging → Senders → WhatsApp senders →
   [el sender] → Status callback URL** →
   `https://<project-ref>.functions.supabase.co/twilio-status-webhook`.
   Además el transporte manda esa misma URL como `StatusCallback` en cada mensaje
   cuando `TWILIO_STATUS_CALLBACK_URL` está seteado (cinturón y tiradores: si el
   sender queda sin configurar, los callbacks llegan igual).
3. **La URL tiene que ser idéntica** a `TWILIO_STATUS_CALLBACK_URL`: la firma se
   calcula sobre la URL completa, así que un `/` de más da 403.

Mapeo de estados de Twilio al vocabulario de `notification_log`:

| `MessageStatus` | `provider_status` |
|---|---|
| `queued`, `sending` | `accepted` |
| `sent` | `sent` |
| `delivered` | `delivered` |
| `read` | `read` |
| `failed`, `undelivered` | `failed` (+ `error` con `ErrorCode`/`ErrorMessage`) |

Se respetan las dos reglas del webhook de Meta: **el rank nunca retrocede**
(`accepted<sent<delivered<read<failed`, los callbacks llegan desordenados), `read`
completa `delivered_at` si ese evento se perdió, y un **fallo de entrega NO toca
`status`** (el drenado reencola `failed` y reenviaría un mensaje ya cobrado).

**Auth del webhook:** firma `X-Twilio-Signature` =
`base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url + params POST ordenados por clave,
concatenados clave+valor))`, comparada en tiempo constante. Sin firma válida →
**403**. Si `TWILIO_AUTH_TOKEN` no está seteado la validación se saltea (mismo
patrón de dev local que `hottok`/`x-cron-secret`/`WHATSAPP_APP_SECRET`); **en prod
DEBE estar seteado**.

---

## El switch — ventana coordinada

Los mensajes en vuelo son **reales y cobrados**: no hay dry-run que amortigüe un
error de secuencia. Además, si el número se **migra** desde la WABA actual, hay un
corte de envío mientras dura la migración.

1. **Pausar el cron** para que no drene en medio del cambio:
   ```sql
   select cron.alter_job(jobid := 1, active := false);   -- notification-dispatch
   select jobid, jobname, active from cron.job;          -- verificar
   ```
2. **Deployar** las funciones: `supabase functions deploy notification-dispatch`
   y `supabase functions deploy twilio-status-webhook`.
3. **Cargar los secrets** (tabla de arriba) en el Dashboard, `WHATSAPP_PROVIDER=twilio`
   incluido. Dejar `WHATSAPP_DRY_RUN=false` como está.
4. **Pegar el status callback** en el sender de Twilio.
5. **Probar con un número propio**: invocar `notification-dispatch` a mano y
   verificar que la fila queda `sent` con `provider_message_id` empezando en `SM…`
   y que a los segundos aparece `provider_status='delivered'`.
6. **Reactivar el cron**:
   ```sql
   select cron.alter_job(jobid := 1, active := true);
   ```

**Rollback:** poner `WHATSAPP_PROVIDER=meta` (o borrar el secret) y listo — el
camino Meta no se tocó. Las filas ya mandadas por Twilio conservan su `SM…` y
siguen recibiendo callbacks por `twilio-status-webhook`, que queda desplegado.

> No hace falta re-absorber backlog al cambiar de proveedor: el dedupe de `0034`
> es por `(entidad, plantilla, canal)` y no mira el proveedor, así que lo ya
> enviado no se re-encola.

---

## Qué mirar si algo no sale

| Síntoma | Causa típica |
|---|---|
| Todo queda en `sent` con `payload.dry_run:true` | falta alguna de las 4 credenciales de Twilio, o `WHATSAPP_DRY_RUN` no está en `false` |
| `twilio: sin ContentSid para X` | falta esa llave en `TWILIO_CONTENT_SIDS` (o el JSON no parsea → el mapa queda vacío y fallan las 6) |
| `Twilio 401: …` | Account SID / Auth Token mal copiados |
| `Twilio 400: … 63016 …` | se mandó fuera de la ventana de 24 h sin plantilla aprobada, o el ContentSid no corresponde a ese sender |
| `Twilio 400: … 21211 …` | `To` inválido — mirar `_shared/phone.ts`, el número no era un móvil EC normalizable |
| Los callbacks no asientan nada | la URL del sender no coincide con `TWILIO_STATUS_CALLBACK_URL` (403 por firma), o el mensaje salió antes del switch y su id es un `wamid` de Meta |

---

## Estado real de la cuenta Twilio (2026-09-08)

Cuenta **"My First Twilio Account"** (Account SID termina en `…88a7a`; se lee en
Console → Account Info y NO va en el repo: la push protection de GitHub lo bloquea).
Única del usuario, upgraded, saldo USD 20. Hecho por Claude desde la Console:

- **Las 6 plantillas están CREADAS y ENVIADAS a revisión de WhatsApp** (estado
  `Received`, categoría `Utility`, idioma Spanish (ES), tipo Text). El cuerpo coincide
  carácter por carácter con `notificationTemplates.ts`, saltos de línea incluidos.
  Valores de muestra cargados (`Andrés`, `Chevrolet Sail PBC-5251`, fecha, firma).

| Plantilla | Content SID |
|---|---|
| `appointment_confirmed` | `HX491c65b376270cf1f993a765b4a56173` |
| `appointment_reminder_24h` | `HX00b84580cb9b6063b05faeade870b81d` |
| `vehicle_received` | `HX8cc845313e0a70f8033a292a562853a2` |
| `quote_ready` | `HX23a4f1b4acc63eb23d4c140bafe504c4` |
| `vehicle_ready` | `HX9900973e9f548a611deab5c01793ccb5` |
| `delivery_completed` | `HX4d47bef311990c6a3515d37bcfdb41f1` |

Valor listo para pegar en el secret `TWILIO_CONTENT_SIDS`:

```json
{"appointment_confirmed":"HX491c65b376270cf1f993a765b4a56173","appointment_reminder_24h":"HX00b84580cb9b6063b05faeade870b81d","vehicle_received":"HX8cc845313e0a70f8033a292a562853a2","quote_ready":"HX23a4f1b4acc63eb23d4c140bafe504c4","vehicle_ready":"HX9900973e9f548a611deab5c01793ccb5","delivery_completed":"HX4d47bef311990c6a3515d37bcfdb41f1"}
```

- **NO hay sender de WhatsApp registrado** (Numbers & senders → WhatsApp muestra el
  "Get Started" inicial; tampoco hay números de Twilio ni sandbox activado). Ese paso
  exige login de Facebook con acceso al portafolio de Meta, OTP al número y aceptar los
  términos de Meta/Twilio: lo hace una persona, no Claude. Hasta que exista el sender,
  `TWILIO_WHATSAPP_FROM` no tiene valor y las plantillas aprobadas no se pueden usar.
- Gotchas de la Console (One Console, `1console.twilio.com`): las páginas tardan
  5–10 s en hidratar; el editor de cuerpo acepta setear el `textarea` por JS con el
  native setter + evento `input`; el botón final "Submit" del diálogo de categoría hay
  que clickearlo de verdad (un `.click()` por JS no dispara el envío).

### 2026-09-09 — los SIDs de arriba son la SEGUNDA tanda (gotcha "Received" que nunca llega a Meta)

Las 6 plantillas originales del 2026-09-08 quedaron en `Received` en Twilio más de 24 h y
**nunca aparecieron en WhatsApp Manager** (0 plantillas en la WABA `384688771391405`):
Twilio no las reenvió a Meta porque en ese momento la cuenta solo tenía senders de prueba
(+1 555…). El botón "Submit for WhatsApp approval" queda deshabilitado mientras diga
`Received`, así que no hay reenvío posible: la solución fue **Duplicate → renombrar sin el
prefijo `copy_of_` → Save and submit (Utility)** con el sender real ya Online. Las copias
aparecieron en Meta en segundos como `<nombre>_hx<sid>` en estado "En revisión"
(`appointment_reminder_24h` quedó Activa a los minutos).

Los SIDs viejos (HX0208…, HXf5fd…, HX5fc9…, HXa237…, HXea2c…, HXa405…) quedaron como
basura en Twilio; se pueden borrar. `TWILIO_CONTENT_SIDS` en prod debe apuntar a los nuevos.

Sender real: **+593 98 438 2565** (migrado desde la WABA de Zoho: hubo que borrarlo de esa
WABA con contraseña de Meta, esperar 3 min y registrarlo desde "Create new sender" con "My
own phone number"; el número tenía que tener la verificación en dos pasos desactivada y un
chip que reciba el SMS). Estado: Online, calidad Alta. Status callback cargado en el sender.

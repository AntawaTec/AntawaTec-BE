# Correos de la orden con PDF — ventana de deploy

> Runbook del lote **L2**: migraciones `0040` + `0041` y la Edge Function
> `notification-dispatch`. **No es opcional.** Ejecutado en el orden equivocado,
> este lote le manda correos reales a los clientes de ~1.300 órdenes históricas.
>
> Leer antes: la sección «Notificaciones» de `CLAUDE.md` y la cabecera de
> `supabase/migrations/0041_notification_backfill_email_events.sql`.

## Qué trae el lote

| Pieza | Qué cambia |
|---|---|
| `0040` | Agrega `work_in_process` al enum `notification_template` (7º valor). |
| `0041` | **Contención**: siembra filas terminales para los pares nuevos `(work_in_process, email)` y `(delivery_completed, email)`. |
| `notification-dispatch` | Barre `work_in_process` (email) y suma el canal email a `delivery_completed`; el drenado genera y adjunta PDFs. |
| `_shared/orderPdf.ts`, `orderSnapshot.ts`, `catalogSummary.ts`, `legal.ts` | Generación del PDF (nuevos). |
| `_shared/emailTransport.ts`, `emailTemplates.ts` | Adjuntos de Resend + dos renderers nuevos. |

Efecto en producción:
- **Recepción** (`vehicle_received`, email): el correo que ya existía ahora lleva
  la **orden de trabajo en PDF**, y sale **15 minutos después** de crearse la
  orden (HOLD) en vez de en el primer tick.
- **En proceso** (`work_in_process`, email): correo NUEVO, sin adjunto.
- **Entrega** (`delivery_completed`, email): correo NUEVO con el **recibo en PDF**.
- WhatsApp: **sin cambios** (ninguna plantilla nueva, ningún texto tocado).

## El riesgo, en una línea

`sweep()` es state-driven y **sin ventana temporal**: si el código que encola un
par `(plantilla, canal)` se deploya antes de que existan las filas de dedupe, el
primer tick del cron encola TODO el histórico y el drenado lo manda — **ambos
canales están en vivo en prod**. Por eso el orden es: **cron pausado → migración
→ verificar → función**.

---

## Ventana de deploy

### Paso 0 — Anotar los conteos (ANTES de tocar nada)

```sql
-- a) Cuántas filas debería sembrar 0041.
select count(*) filter (where status in ('in_process','delivery','historical')) as esperado_work_in_process,
       count(*) filter (where status = 'historical')                            as esperado_delivery_completed,
       count(*)                                                                  as total_ordenes
  from public.work_orders;

-- b) Foto del log antes del lote (para comparar después).
select template, channel, status, count(*)
  from public.notification_log
 group by 1,2,3 order by 1,2,3;
```

Anotar los dos números de (a) en algún lado: son el control del Paso 3.

### Paso 1 — Pausar el cron

```sql
select jobid, jobname, schedule, active from cron.job;   -- confirmar el jobid
select cron.alter_job(1, active := false);               -- jobid de 'notification-dispatch'
select jobid, jobname, active from cron.job;             -- verificar active = false
```

> El `jobid` es 1 si `0024` fue el primer `cron.schedule` del proyecto — **no
> asumirlo**, mirarlo en la primera consulta. Con el cron pausado, el pipeline
> queda congelado: nada se encola ni se drena hasta el Paso 6.

### Paso 2 — Aplicar las migraciones

```bash
supabase migration list          # confirmar que faltan 0040 y 0041, y nada más
supabase db push                 # aplica 0040 y 0041
```

> Son **dos archivos a propósito**: Postgres no deja usar un valor de enum en la
> misma transacción que lo agrega (`0040` lo agrega, `0041` lo referencia).

### Paso 3 — Verificar el backfill (control de contención)

```sql
-- Tiene que coincidir con lo anotado en el Paso 0.
select template, count(*)
  from public.notification_log
 where channel = 'email' and payload->>'migration' = '0041'
 group by 1;

-- Y NO puede haber nada 'queued' para los pares nuevos.
select template, channel, status, count(*)
  from public.notification_log
 where template in ('work_in_process','delivery_completed')
 group by 1,2,3 order by 1,2,3;
```

🛑 **Si los números no coinciden, PARAR acá.** Con el cron pausado y la función
vieja todavía desplegada no hay riesgo: se puede investigar con calma. Deployar
la función con el backfill incompleto es lo único irreversible del lote.

### Paso 4 — Deployar la función (NUNCA antes del Paso 3)

```bash
supabase functions deploy notification-dispatch
```

### Paso 5 — Invocación manual y control de que no haya `queued` masivos

Con el cron TODAVÍA pausado, invocar una sola vez a mano:

```bash
curl -s -X POST "https://<project-ref>.functions.supabase.co/notification-dispatch" \
  -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" -d '{}'
```

La respuesta trae `{ enqueued, sent, failed, held, deferred }`:

- `enqueued` debería ser **0 o un puñado** (solo eventos reales de hoy). Un
  `enqueued` de tres dígitos significa que el backfill no cubrió algo → Paso 5b.
- `held` cuenta los correos de recepción esperando el HOLD de 15 min.
- `deferred` cuenta los PDFs que no entraron en el presupuesto del tick
  (`PDF_PER_TICK`); se procesan en las corridas siguientes.

Control inmediato:

```sql
select template, channel, status, count(*)
  from public.notification_log
 where created_at > now() - interval '10 minutes'
 group by 1,2,3 order by 1,2,3;
```

#### Paso 5b — SQL de contención (si aparecen `queued` masivos)

El cron sigue pausado, así que nada se va a mandar mientras tanto. Marcar como
terminales las filas recién encoladas del par problemático **sin borrarlas** (la
fila es lo que impide que se vuelvan a encolar):

```sql
-- 1) Ver exactamente qué se encoló de más.
select id, template, channel, related_entity_id, created_at
  from public.notification_log
 where status = 'queued' and created_at > now() - interval '30 minutes'
 order by created_at desc limit 50;

-- 2) Neutralizarlas (ajustar template/channel a lo que haya aparecido).
update public.notification_log
   set status  = 'sent',
       sent_at = now(),
       payload = coalesce(payload, '{}'::jsonb)
                 || jsonb_build_object('backfill', true,
                                       'note', 'contenida en la ventana de deploy; nunca se envió')
 where status = 'queued'
   and channel = 'email'
   and template in ('work_in_process','delivery_completed')
   and created_at > now() - interval '30 minutes';
```

Recién después volver al Paso 5.

### Paso 6 — Smoke con el taller de prueba

Con el cron **todavía pausado**, sobre una orden de un taller de prueba y un
cliente cuyo email sea propio:

1. Crear una orden → esperar 15 min (HOLD) → invocar a mano → llega el correo
   «Recibimos tu vehículo» con `OT-XXXX-orden.pdf` adjunto.
2. Pasar la orden a `in_process` → invocar → llega «Tu vehículo está en proceso»
   (sin adjunto).
3. Registrar la entrega (pasa a `historical`) → invocar → llega «Recibo de
   entrega» con `OT-XXXX-recibo.pdf`.

Revisar en los PDFs: logo, nombre y dirección del taller, folio `OT-XXXX`,
trabajos del catálogo, repuestos **sin costos**, descargo (solo en la orden) y
firma. Y en la base:

```sql
select template, status, payload->>'pdf_path' as pdf, payload->>'pdf_bytes' as bytes,
       payload->>'logo_skipped' as sin_logo, payload->>'pdf_upload_error' as error_upload
  from public.notification_log
 where related_entity_id = '<work_order_id>' and channel = 'email';

select delivery_pdf_url from public.work_order_deliveries where work_order_id = '<work_order_id>';
```

> Si `logo_skipped` es `true`, el taller tiene logo pero no se pudo embeber
> (típicamente **webp**: pdf-lib solo embebe PNG/JPEG). El documento sale igual;
> la solución es que el taller suba un PNG.
> Si `pdf_upload_error` tiene texto, el correo SÍ salió y solo falló el archivado
> en el bucket `pdfs` — no reintentar el envío.

### Paso 7 — Reanudar el cron

```sql
select cron.alter_job(1, active := true);
select jobid, jobname, active from cron.job;
```

Y mirar los primeros minutos:

```sql
select status, count(*) from public.notification_log
 where created_at > now() - interval '15 minutes' group by 1;
```

---

## Rollback

- **Antes del Paso 4** (función no deployada): no hay nada que revertir. `0040`
  agrega un valor de enum (inerte) y `0041` siembra filas terminales que solo
  PREVIENEN envíos. Se puede dejar así indefinidamente.
- **Después del Paso 4**: redeployar la función desde el commit anterior. Las
  migraciones se quedan (son aditivas y protectoras). Las filas de `0041` no
  molestan a la función vieja.
- **No** borrar las filas sembradas por `0041`: son exactamente lo que impide el
  blast. Borrarlas y reactivar el cron es el peor escenario posible.

## Notas operativas

- **Costo por tick**: `PDF_PER_TICK = 8` PDFs por corrida (cron cada minuto ⇒
  techo de 480/hora). Está para no acercarse al límite de CPU de la Edge Function
  con un lote grande de entregas simultáneas. Si alguna vez hace falta drenar más
  rápido, subirlo es un cambio de una constante… midiendo antes el tiempo de la
  corrida en los logs de la función.
- **Los PDFs se archivan** en `pdfs` bajo `{shop_id}/orders/{work_order_id}/` como
  `orden.pdf` y `recibo.pdf` (upsert: un reenvío pisa el anterior). El recibo
  además escribe `work_order_deliveries.delivery_pdf_url` — esa columna existía
  desde `0007` y nadie la escribía.
- **Re-enviar** un correo sigue bloqueado por el dedupe (una fila por evento y
  canal). Workaround operativo, sabiendo lo que se hace: borrar esa fila de
  `notification_log` y dejar que el barrido la vuelva a encolar.
- **`EMAIL_DRY_RUN`** sigue funcionando igual: en sandbox el PDF se genera y se
  archiva, pero no se manda nada. Es la forma barata de probar el contenido de un
  documento sin gastar un envío.

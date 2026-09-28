# Barrido paginado de notificaciones — ventana de deploy

> Runbook del fix del barrido truncado por `max_rows`: migración `0044` +
> `_shared/paginate.ts` + la Edge Function `notification-dispatch`. **No es
> opcional.** Ejecutado en el orden equivocado, este lote le manda ~290 avisos
> reales (WhatsApp y correo) a clientes de órdenes entregadas hace meses.
>
> Leer antes: la sección «Notificaciones» de `CLAUDE.md` y la cabecera de
> `supabase/migrations/0044_notification_backfill_sweep_cap.sql`. La mecánica de
> pausar/reanudar el cron es la misma de `docs/order-emails-deploy.md` (Pasos 1 y 7).

## El incidente (2026-09-27)

- Desde el **2026-09-22** ninguna orden nueva recibió `vehicle_received` (wa+email),
  `vehicle_ready` (wa) ni `delivery_completed` (wa+email). Twilio y Resend, sanos.
- Causa: PostgREST corta toda respuesta en `max_rows = 1000` (`supabase/config.toml`)
  **sin error**, y `sweep()` leía `work_orders` con un `.select()` sin `.range()`,
  sin `.order()` y con `const { data } = …` (el `error` nunca se miraba).
- Tras el import de Zoho hay ~1.376 órdenes: vuelven 1.000 en orden de heap y todo
  lo creado o movido desde el 22-sep quedaba afuera en cada tick.
- `work_in_process` se salvó (filtra `status = 'in_process'`, ~20 filas). Citas (365)
  y cotizaciones (38) tienen la misma bomba latente, hoy sin huecos.
- Al arreglarlo, el barrido pasa a VER ~296 pares (plantilla, canal) faltantes en 87
  órdenes: 256 de 73 importadas de Zoho y 40 de 14 órdenes reales del 22 al 27-sep.

## Qué trae el lote

| Pieza | Qué cambia |
|---|---|
| `0044` | **Contención**: siembra filas terminales (`sent`, `attempts=0`) para todo lo que el barrido corregido vería faltante, salvo la excepción de abajo. |
| `_shared/paginate.ts` (+ `paginate_test.ts`) | Helper `selectAll`: lee por páginas (≤ `max_rows`) con `.order("id")` + `.range()` y **lanza** si PostgREST devuelve error. |
| `notification-dispatch` | Las 7 queries del barrido pasan por `selectAll`; ventana `updated_at >= now() - 30 días` en `work_orders` (×4), citas de cotización y cotizaciones enviadas (el recordatorio ya acota por `scheduled_at`); upsert de `enqueueMissing` en tramos; la respuesta suma `scanned`. |

Efecto en producción:
- Vuelven los avisos de la orden para las órdenes nuevas: recepción (wa + email,
  el correo tras el HOLD de 15 min), listo (wa) y entrega (wa + email).
- **Un solo envío retroactivo**: el `vehicle_ready` (WhatsApp) de las órdenes que
  hoy están en `delivery` y se crearon desde el 22-sep. Sale en el tick manual del
  Paso 5.
- Un error de lectura en el barrido ahora responde **500** (antes se tragaba y el
  barrido seguía con datos parciales). El cron reintenta al minuto.

### Matriz de siembra (`0044`)

| Plantilla | Canales | Órdenes que se siembran | `sent_at` |
|---|---|---|---|
| `vehicle_received` | whatsapp + email | TODAS | `created_at` |
| `vehicle_ready` | whatsapp | `historical`, y `delivery` creadas **antes** del cutoff | `updated_at` |
| `work_in_process` | email | `in_process`, `delivery`, `historical` (= 0041; casi todo no-op) | `updated_at` |
| `delivery_completed` | whatsapp + email | `historical` (LEFT JOIN a la entrega) | `delivered_at` → `updated_at` |

Cutoff: `timestamptz '2026-09-22 00:00:00-05'` (medianoche hora Ecuador).

⚠️ **La excepción deliberada.** Las órdenes en `delivery` creadas desde el cutoff
**no** se siembran para `vehicle_ready`: son clientes que siguen esperando retirar
el vehículo y nunca supieron que está listo. Al 2026-09-27 son 6: **#12 y #13
(Betel), #631, #633 y #635 (GreenWash), #63 (Pupiales)**. Todo lo demás atrasado
(recepciones de las órdenes nuevas, los recibos de #634 y #657 y las 256 filas de
las importadas) se siembra y **no se manda**. Citas y cotizaciones no se siembran:
están bajo el tope, sin huecos, y la ventana solo achica lo que ven (guardia 0c).

## El riesgo, en una línea

Para el dedupe, que el barrido pase a **ver** filas que antes no veía es lo mismo
que estrenar un par `(plantilla, canal)`: si la función corregida se deploya antes
de que existan las filas de `0044`, el primer tick encola las ~290 y las **manda en
ese mismo request** (barrido y drenado corren en la misma invocación). Por eso el
orden es: **cron pausado → migración → verificar → función**.

## Antes de empezar

- **Fuera del horario de los talleres** (noche o domingo). Una orden creada minutos
  antes del `db push` queda sembrada y pierde su `vehicle_received`.
- CLI: `npx -y supabase@latest …` desde el checkout del BE en `main` actualizado y
  linkeado a `qldeexeshdzrithjagqq` (el `supabase` de brew muere con exit 137).
- El secret del tick manual es el mismo que manda el cron:
  `select current_setting('app.cron_secret', true);` → `export CRON_SECRET='…'`.

---

## Ventana de deploy

### Paso 0 — Anotar los conteos (ANTES de tocar nada)

```sql
-- 0a — ESPERADO por bloque (candidatos de 0044 sin fila) — ≈ 290 en total al 2026-09-27
--      (algo más en work_in_process, que se siembra de más):
with cand as (
  select w.id, 'vehicle_received' t, c.ch from public.work_orders w cross join (values ('whatsapp'),('email')) c(ch)
  union all select w.id, 'vehicle_ready', 'whatsapp' from public.work_orders w
    where w.status = 'historical' or (w.status = 'delivery' and w.created_at < timestamptz '2026-09-22 00:00:00-05')
  union all select w.id, 'work_in_process', 'email' from public.work_orders w where w.status in ('in_process','delivery','historical')
  union all select w.id, 'delivery_completed', c.ch from public.work_orders w cross join (values ('whatsapp'),('email')) c(ch) where w.status = 'historical')
select c.t as template, c.ch as channel, count(*) as esperado from cand c
  left join public.notification_log n on n.related_entity_type = 'work_order' and n.related_entity_id = c.id
   and n.template::text = c.t and n.channel::text = c.ch
 where n.id is null group by 1,2 order by 1,2;

-- 0b — las ÚNICAS que recibirán vehicle_ready tarde (hoy 6: #12 #13 #631 #633 #635 #63):
select order_number, shop_id, status, created_at from public.work_orders
 where status = 'delivery' and created_at >= timestamptz '2026-09-22 00:00:00-05' order by created_at;

-- 0c — guardia citas/cotizaciones: bajo 1000 y SIN huecos (las tres filas de abajo en 0).
select (select count(*) from public.appointments where source = 'quote') citas_quote,
       (select count(*) from public.quotes where sent_at is not null)   quotes_sent;
select 'appointment_confirmed/whatsapp' as par, count(*) as huecos
  from public.appointments a
 where a.source = 'quote'
   and not exists (select 1 from public.notification_log n
                    where n.related_entity_type = 'appointment' and n.related_entity_id = a.id
                      and n.template = 'appointment_confirmed' and n.channel = 'whatsapp')
union all
select 'quote_ready/' || c.ch, count(*)
  from public.quotes q cross join (values ('whatsapp'),('email')) c(ch)
 where q.sent_at is not null
   and not exists (select 1 from public.notification_log n
                    where n.related_entity_type = 'quote' and n.related_entity_id = q.id
                      and n.template = 'quote_ready' and n.channel::text = c.ch)
 group by c.ch;
```

- Anotar los números de **0a**: son el control del Paso 3.
- **0b**: si aparece alguna orden creada cerca de la medianoche del 21/22-sep que no
  debería recibir el aviso (o falta una que sí), ajustar el literal del cutoff en
  `0044` **antes** del push — después la migración es inmutable.
- **0c**: si algún conteo pasa de 1000 o hay huecos, PARAR: `0044` no los cubre y el
  paginado los mandaría.

### Paso 1 — Pausar el cron

```sql
select jobid, jobname, schedule, active from cron.job;   -- anotar el jobid REAL de 'notification-dispatch'
select cron.alter_job(<jobid>, active := false);
select jobid, jobname, active from cron.job;             -- verificar active = false
```

> No asumir el `jobid` (ver `docs/order-emails-deploy.md`, Paso 1). Con el cron
> pausado nada se encola ni se drena hasta el Paso 7. Si pasaron más de un par de
> minutos desde el Paso 0, **volver a correr 0a ahora**: con el cron quieto ese
> número ya no se mueve, y es el que se compara en el Paso 3.

### Paso 2 — Aplicar la migración

```bash
npx -y supabase@latest migration list   # confirmar que falta 0044, y nada más
npx -y supabase@latest db push          # aplica 0044
```

### Paso 3 — Verificar el backfill (control de contención)

```sql
-- 3 — sembrado == esperado (0a), fila por fila de (template, channel)…
select template, channel, count(*) sembrado from public.notification_log
 where payload->>'migration' = '0044' group by 1,2 order by 1,2;

-- …y nada 'queued' nuevo (tiene que volver vacío):
select template, channel, count(*) from public.notification_log
 where status = 'queued' and created_at > now() - interval '10 minutes' group by 1,2;

-- 3b — SIMULACIÓN del primer tick de la función nueva (misma ventana, mismas
--      condiciones que sweep()). Tiene que devolver EXACTAMENTE las órdenes de 0b
--      con vehicle_ready/whatsapp, y nada más.
with win as (
  select * from public.work_orders where updated_at >= now() - interval '30 days'
), cand as (
  select w.id, 'vehicle_received' t, c.ch from win w cross join (values ('whatsapp'),('email')) c(ch)
  union all select w.id, 'vehicle_ready', 'whatsapp' from win w where w.status in ('delivery','historical')
  union all select w.id, 'work_in_process', 'email' from win w where w.status = 'in_process'
  union all select w.id, 'delivery_completed', c.ch from win w cross join (values ('whatsapp'),('email')) c(ch) where w.status = 'historical')
select c.t as template, c.ch as channel, w.order_number, w.status, w.created_at
  from cand c
  join public.work_orders w on w.id = c.id
  left join public.notification_log n on n.related_entity_type = 'work_order' and n.related_entity_id = c.id
   and n.template::text = c.t and n.channel::text = c.ch
 where n.id is null
 order by w.created_at;
```

🛑 **Si 3 no coincide con 0a o 3b devuelve algo más que las órdenes de 0b, PARAR
acá.** Con el cron pausado y la función vieja todavía desplegada no hay riesgo: se
puede investigar con calma. **Este es el gate real del lote**: el Paso 5 ya manda
lo que encola (ver abajo), así que la contención 5b solo salva el remanente.

### Paso 4 — Deployar la función (NUNCA antes del Paso 3)

```bash
npx -y supabase@latest functions deploy notification-dispatch
```

### Paso 5 — Un solo tick manual y control de lo encolado

Con el cron TODAVÍA pausado:

```bash
curl -s -X POST "https://qldeexeshdzrithjagqq.functions.supabase.co/notification-dispatch" \
  -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" -d '{}'
```

La respuesta trae `{ enqueued, scanned, sent, failed, held, deferred }`:

- `enqueued` ≈ **6** (los de 0b) + algún evento real de la ventana de deploy.
- `sent` ≈ lo mismo: **barrido y drenado corren en la misma invocación**, así que lo
  encolado en este tick ya se manda en este tick (hasta `DRAIN_LIMIT = 100`; los
  correos de recepción esperan el HOLD de 15 min y los PDFs pasan por `PDF_PER_TICK`).
- `scanned` ≈ **4k** es **esperado** hasta ~**2026-10-22**: es la SUMA de los 7
  bloques del barrido, y las ~1.400 órdenes importadas de Zoho (con `updated_at` =
  fecha del import, dentro de la ventana de 30 días) se leen hasta tres veces
  (`vehicle_received`, `vehicle_ready`, `delivery_completed`). Ya están sembradas,
  así que solo cuestan filas leídas, no envíos. Después baja a lo que se movió en
  el último mes (decenas).
- Un **500** es un error de lectura del barrido (ahora lanza en vez de tragarse el
  `error`): mirar los logs de la función antes de seguir.

```sql
-- 5 — lo encolado por el tick DEBE ser: vehicle_ready/whatsapp de 0b + eventos reales:
select n.template, n.channel, n.status, w.order_number, w.status estado, w.created_at
  from public.notification_log n join public.work_orders w on w.id = n.related_entity_id
 where n.related_entity_type = 'work_order' and n.created_at > now() - interval '10 minutes'
   and coalesce(n.payload->>'backfill','') <> 'true' order by n.created_at;
```

Si aparece una orden que no está en 0b, contrastarla con la app: una orden creada o
que cambió de estado DURANTE la ventana es un evento real (minutos tarde) y está
bien que salga.

#### Paso 5b — SQL de contención (si `enqueued` tiene tres dígitos)

El cron sigue pausado, así que lo que quede `queued` no se manda. Marcar como
terminal lo encolado de más **sin borrarlo** (la fila es lo que impide que se vuelva
a encolar), preservando los `vehicle_ready` legítimos:

```sql
-- 5b — neutraliza lo recién encolado, salvo los vehicle_ready de 0b:
update public.notification_log n set status = 'sent', sent_at = now(),
       payload = coalesce(payload,'{}'::jsonb) || jsonb_build_object('backfill', true, 'note', 'contenida en la ventana de deploy 0044; nunca se envió')
  from public.work_orders w
 where w.id = n.related_entity_id and n.related_entity_type = 'work_order' and n.status = 'queued'
   and n.created_at > now() - interval '30 minutes'
   and not (n.template = 'vehicle_ready' and w.status = 'delivery' and w.created_at >= timestamptz '2026-09-22 00:00:00-05');
```

> ⚠️ 5b solo alcanza lo que todavía está `queued`: lo que el tick del Paso 5 ya drenó
> (hasta 100 filas, WhatsApp al instante) **ya salió**. Por eso el gate es el Paso 3.
> Si hay que correr 5b, excluir antes a mano cualquier evento real identificado en la
> query 5, y volver a invocar el Paso 5 hasta que `enqueued` sea 0.

### Paso 6 — Confirmar los 6 `vehicle_ready`

```sql
select w.order_number, w.shop_id, n.status, n.provider_status, n.error, n.sent_at, n.delivered_at, n.read_at
  from public.notification_log n join public.work_orders w on w.id = n.related_entity_id
 where n.related_entity_type = 'work_order' and n.template = 'vehicle_ready' and n.channel = 'whatsapp'
   and w.status = 'delivery' and w.created_at >= timestamptz '2026-09-22 00:00:00-05'
 order by w.order_number;
```

Las 6 filas deberían estar `sent`; el webhook de Twilio completa `provider_status`
(`delivered` / `read`) en los minutos siguientes. Un `failed` se reintenta solo
cuando se reanude el cron.

### Paso 7 — Reanudar el cron

```sql
select cron.alter_job(<jobid>, active := true);
select jobid, jobname, active from cron.job;

-- el drenado de lo real (Twilio → provider_status delivered/read):
select template, channel, status, provider_status, error from public.notification_log
 where created_at > now() - interval '30 minutes' and coalesce(payload->>'backfill','') <> 'true';
```

### Después de la ventana

- Al día siguiente, una orden nueva creada en la app tiene que generar
  `vehicle_received` por WhatsApp (al minuto) y por correo (tras el HOLD de 15 min).
  Hoy no lo hace: es la prueba de que el fix funciona.
- `scanned` en los logs del cron ≈ 4k hasta ~2026-10-22 (ver Paso 5); no es un
  problema de performance ni de envíos.

---

## Rollback

- **Antes del Paso 4** (función no deployada): no hay nada que revertir. `0044` solo
  siembra filas terminales que PREVIENEN envíos. Reanudar el cron con la función
  vieja deja todo como estaba (con el bug del truncado, pero sin riesgo).
- **Después del Paso 4**: redeployar la función desde el commit anterior al merge
  (hoy `b622bd1`), por ejemplo desde un worktree aparte:
  ```bash
  git worktree add ../AntawaTec-BE-rollback <sha-anterior>
  cd ../AntawaTec-BE-rollback && npx -y supabase@latest functions deploy notification-dispatch --project-ref qldeexeshdzrithjagqq
  ```
  La migración se queda (es aditiva y protectora). Ojo: la función vieja **vuelve al
  truncado** — las órdenes nuevas dejan de recibir avisos. Es un freno de emergencia,
  no un estado estable.
- **No** borrar las filas sembradas por `0044`: son exactamente lo que impide el
  blast. Borrarlas con la función nueva desplegada es el peor escenario posible.

## Riesgos y casos borde

- **Entre el push y el deploy** (cron pausado): una orden creada ahí no queda
  sembrada → la función nueva la encola en el tick manual. Correcto: es un evento
  real, minutos tarde. Igual para una que pase a `historical` en ese lapso.
- **Estado cambiado durante el runbook**: aparece en la query 5 como evento real;
  contrastar con la app antes de neutralizarlo con 5b.
- **Orden de más de 30 días movida hoy**: entra en el barrido (todo UPDATE bumpea
  `updated_at` vía `set_updated_at`). **Solo un comentario** de módulo: no entra
  (vive en `work_order_module_comments`, no toca la orden). Ambos correctos.
- **`.range()` vs `max_rows`**: cada página también se capa a 1000; el helper
  rechaza `pageSize > 1000` para que nunca se trunque en silencio.
- **Error de lectura → 500 del tick** (antes se tragaba y seguía): se salta también
  el drenado de ese minuto; pg_net lo loguea y el cron reintenta. Mismo
  comportamiento que ya tenían `loadShops` / `enqueueMissing`.
- **Cutoff `-05`**: si alguna orden en `delivery` se creó cerca de la medianoche del
  21/22-sep, 0b lo muestra ANTES del push; ajustar el literal en `0044` antes de
  pushear (después es inmutable).
- **`sent_at` sembrado no es evidencia de entrega**: toda fila de `0044` lleva
  `payload.backfill = true` y `payload.migration = '0044'`.
- **Pipeline caído más de 30 días** (a futuro): lo que quedó fuera de la ventana no
  se manda nunca. Si alguna vez hay que ampliarla, se siembra ANTES, nunca al revés.

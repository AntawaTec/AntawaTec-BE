# Prueba gratis por código promocional — deploy a producción

> Runbook de la campaña «30 días gratis por código» (2026-10, acordada con Pablo y
> Javier): migraciones `0047` + `0048`, Edge Functions `promo-intake` y
> `trial-reminder`, y el cambio en `subscription-renewal-approval` que convierte la
> prueba en plan pagado al aprobar la primera renovación.
>
> A diferencia de `docs/sweep-pagination-deploy.md`, este lote **no tiene blast
> retroactivo**: no hay ninguna subscription `trial` hasta que alguien canjee un
> código, y el cron nuevo es NO-OP mientras no se configure (Paso 3). El orden
> importa igual, por otra razón: **la landing no debe publicar el link de la campaña
> antes del Paso 5** (un 404/500 en el formulario quema el anuncio).

## Qué trae el lote

| Pieza | Qué cambia |
|---|---|
| `0047` | `'trial'` en el enum `subscription_provider` (aislada, como `0036`). |
| `0048` | Tablas `promo_codes` y `promo_redemptions` (RLS solo admin), columna `subscriptions.trial_reminder_sent_at`, cron `trial-reminder` diario `0 13 * * *` (08:00 Ecuador). |
| `promo-intake` | Nueva. La llama la landing (anónima): valida el código, crea el canje y provisiona el taller con `provider = 'trial'`, `plan = <código>` y `trial_days` del código. Manda el magic link de siempre. |
| `trial-reminder` | Nueva. La llama el cron: un correo al dueño 7 días antes de que venza la prueba («Tu prueba de AntawaTec termina el …»). Nunca suspende. |
| `subscription-renewal-approval` | Al aprobar una renovación de un taller en prueba, la fila pasa de `trial` a `bank_transfer` / `mensual`. |
| `_shared/provisionTenant.ts` | `periodDays?` y `contactPhone?` opcionales; los callers existentes no cambian. |

**Lo que NO hace** (a propósito, V1): no suspende a nadie. Al vencer la prueba, el
admin suspende A MANO desde /admin. El taller suspendido ve la pantalla de pago del FE
y, al aprobarse su renovación, `subscription-renewal-approval` lo reactiva solo.

## Antes de empezar

- CLI: `npx -y supabase@latest …` desde el checkout del BE en `main` actualizado y
  linkeado a `qldeexeshdzrithjagqq` (el `supabase` de brew muere con exit 137).
- Secrets que estas funciones usan y **ya existen** en prod (no hay secrets nuevos):
  `CRON_SECRET`, `EMAIL_DRY_RUN`, `RESEND_API_KEY`, `EMAIL_FROM`,
  `ONBOARDING_REDIRECT_URL`. Verificar en Dashboard → Edge Functions → Secrets
  (`supabase secrets` está roto por el token de go-keyring).
- ⚠️ **El correo está EN VIVO en prod** (`EMAIL_DRY_RUN=false`): el tick manual del
  Paso 5 manda correos reales a cualquier prueba que esté a ≤ 7 días de vencer. El
  día del deploy no hay ninguna, así que no sale nada; más adelante, un tick manual
  es un envío real.
- `CRON_SECRET`: en prod **`app.cron_secret` NO está seteado** — el secret del job
  `notification-dispatch` vive inline en su comando. Para leerlo:
  ```sql
  select command from cron.job where jobname = 'notification-dispatch';
  ```
  y copiar el valor de `'x-cron-secret', '…'` → `export CRON_SECRET='…'`.

---

## Paso 1 — Migraciones

```bash
npx -y supabase@latest migration list   # confirmar que faltan 0047 y 0048, y nada más
npx -y supabase@latest db push          # aplica 0047 + 0048 (dos transacciones)
```

Verificar:

```sql
select unnest(enum_range(null::public.subscription_provider));   -- incluye 'trial'
select count(*) from public.promo_codes;                         -- 0 (el código va en el Paso 4)
select column_name from information_schema.columns
 where table_schema = 'public' and table_name = 'subscriptions'
   and column_name = 'trial_reminder_sent_at';                   -- 1 fila
select jobid, jobname, schedule, active from cron.job;           -- aparece 'trial-reminder', 0 13 * * *
```

El job recién creado es NO-OP: lee `app.trial_reminder_url`, que en prod no existe.

## Paso 2 — Deployar las funciones

```bash
npx -y supabase@latest functions deploy promo-intake --project-ref qldeexeshdzrithjagqq
npx -y supabase@latest functions deploy trial-reminder --project-ref qldeexeshdzrithjagqq
npx -y supabase@latest functions deploy subscription-renewal-approval --project-ref qldeexeshdzrithjagqq
```

`verify_jwt = false` sale de `config.toml` (las dos nuevas lo necesitan: una la llama
un anónimo, la otra pg_cron). Confirmar en Dashboard → Edge Functions que ambas
figuran con «Verify JWT» apagado.

## Paso 3 — Cron en prod (secret y URL inline)

Mismo esquema que el job de `notification-dispatch`: como `app.cron_secret` no existe
en prod, el comando del job se reescribe con la URL y el secret **literales**. Así no
depende de ningún `alter database … set` (que el rol de prod no siempre puede hacer).

```sql
select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'trial-reminder'),
  command := $cmd$
    select net.http_post(
      url     := 'https://qldeexeshdzrithjagqq.supabase.co/functions/v1/trial-reminder',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', '<CRON_SECRET>'
      ),
      body    := '{}'::jsonb
    );
  $cmd$
);
```

> Reemplazar `<CRON_SECRET>` por el valor real **en el editor SQL, no en un archivo
> commiteado**. Si algún día se setea `app.trial_reminder_url` + `app.cron_secret`
> a nivel base, el comando original de `0048` vuelve a servir tal cual y este paso
> se puede revertir.

Verificar:

```sql
select jobid, jobname, schedule, active from cron.job;   -- trial-reminder | 0 13 * * * | t
select command from cron.job where jobname = 'trial-reminder';  -- URL y secret literales
```

## Paso 4 — Crear el código de la campaña

```sql
insert into public.promo_codes (code, trial_days, max_uses, expires_at, notes)
values (
  'CODIGO',                                   -- MAYÚSCULAS, 4–20 de [A-Z0-9] (lo exige un check)
  30,                                         -- días de prueba (1–90)
  null,                                       -- tope de canjes; null = sin tope
  timestamptz '2026-12-31 23:59:59-05',       -- fecha de cierre en hora Ecuador; null = no caduca
  'Campaña <nombre> — anuncio <canal>, <fecha>'
);
select * from public.promo_codes;
```

El link que se pasa al equipo de marketing es
`https://antwt.com/prueba?codigo=CODIGO`.

## Paso 5 — Smoke en prod

Usar un email propio que **no** tenga cuenta en AntawaTec (con uno existente la
respuesta correcta es el 409).

```bash
curl -s -X POST "https://qldeexeshdzrithjagqq.supabase.co/functions/v1/promo-intake" \
  -H "content-type: application/json" \
  -d '{"code":"CODIGO","businessName":"Taller Smoke Antawa","email":"<email-de-prueba>","phone":"0983924303","website":""}'
# → 201 {"shopId":"…","email":"…","periodEnd":"…"}  (≈ ahora + trial_days)
```

```sql
select s.id, s.name, s.status, s.contact_phone, sub.provider, sub.plan, sub.current_period_end
  from public.shops s join public.subscriptions sub on sub.shop_id = s.id
 where s.contact_email = '<email-de-prueba>';          -- provider = trial, plan = CODIGO
select * from public.promo_redemptions order by created_at desc limit 5;   -- shop_id lleno
```

- Llega el invite (magic link) al email de prueba; entrar y ver el dashboard vacío.
- Repetir el mismo curl: vuelve el **mismo** `shopId` (reintento idempotente).
- Probar el 400: `"code":"NOEXISTE"` → «Este código no es válido o ya venció.»

Tick manual de `trial-reminder` (no manda nada si no hay pruebas a ≤ 7 días):

```bash
curl -s -X POST "https://qldeexeshdzrithjagqq.supabase.co/functions/v1/trial-reminder" \
  -H "x-cron-secret: $CRON_SECRET" -H "content-type: application/json" -d '{}'
# → {"scanned":0,"sent":0,"failed":0,"dryRun":false}
```

Para ver el correo de verdad, acercar el vencimiento SOLO del taller de smoke y
volver a tirar el tick (llega «Tu prueba de AntawaTec termina el …» al email de
prueba):

```sql
update public.subscriptions set current_period_end = now() + interval '5 days'
 where provider = 'trial'
   and shop_id = (select id from public.shops where contact_email = '<email-de-prueba>');
```

Limpieza del smoke (con service_role / SQL editor): primero la fila de
`promo_redemptions` (`delete from public.promo_redemptions where email = '<email-de-prueba>'`,
para que no cuente contra `max_uses`), después el taller (`delete from public.shops where
contact_email = '<email-de-prueba>'` — cascadea subscription y profile) y por último el
usuario de auth desde Dashboard → Authentication → Users.

Recién acá: avisar a la landing que puede publicar el link de la campaña.

## Paso 6 — Operación y cierre de la campaña

Seguimiento:

```sql
-- canjes por código
select code, count(*) canjes, count(shop_id) con_taller from public.promo_redemptions group by 1;
-- pruebas vigentes / vencidas
select s.name, s.contact_email, s.status, sub.current_period_end, sub.trial_reminder_sent_at
  from public.subscriptions sub join public.shops s on s.id = sub.shop_id
 where sub.provider = 'trial' order by sub.current_period_end;
```

- Vencida la prueba, el admin suspende el taller desde /admin (botón «Suspender»).
- Cuando el taller paga, sube su comprobante desde la pantalla de suspendido y el
  admin lo aprueba como cualquier renovación: la subscription pasa a
  `bank_transfer` / `mensual` y el taller se reactiva solo.

Cerrar la campaña (los canjes ya hechos siguen intactos; el link empieza a responder
«Este código no es válido o ya venció.»):

```sql
update public.promo_codes set active = false where code = 'CODIGO';
```

Pausar solo los recordatorios (sin tocar el resto):

```sql
select cron.alter_job((select jobid from cron.job where jobname = 'trial-reminder'), active := false);
```

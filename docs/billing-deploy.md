# Facturación electrónica SRI — deploy

> Runbook del módulo de facturación (v1: solo factura) vía **AutorizadorEC**, modo
> multiempresa: migraciones `0049`–`0053` y Edge Functions `billing-setup`,
> `invoice-emit`, `invoice-webhook` e `invoice-reconcile`.
>
> **No tiene blast retroactivo**: ningún taller factura hasta que el admin le prende
> `billing_enabled`, y el cron nuevo solo mira facturas en `processing` (no hay
> ninguna el día del deploy). El orden importa por otra razón: **sin los secrets del
> Paso 2 las funciones responden 500** y el FE de facturación no sirve; no hay un
> modo dry-run que "simule" una factura autorizada (sería un comprobante falso).

## Qué trae el lote

| Pieza | Qué cambia |
|---|---|
| `0049` | Enums `invoice_status` y `buyer_id_type`. |
| `0050` | `shops.billing_enabled`; `customers.id_type/id_number/address` (opcionales); tabla `shop_billing_settings` (dueño y admin solo leen); la API key del proveedor por taller en **Vault** detrás de `set_/get_billing_provider_key` (solo `service_role`). |
| `0051` | `invoices` + `invoice_items` (el dueño solo escribe borradores; ítems congelados fuera de borrador por trigger) y el lock `acquire_invoice_for_emission`. Agrega `customers_id_shop_key` y `products_id_shop_key` (unique `(id, shop_id)` para los FK compuestos; no pueden fallar: `id` ya es PK). |
| `0052` | Bucket privado `invoices` (XML/RIDE): dueño y admin leen; escribe solo `service_role`. |
| `0053` | Cron `invoice-reconcile` cada 5 min (NO-OP hasta el Paso 4). |
| Funciones | `billing-setup` y `invoice-emit` (las llama el dueño), `invoice-webhook` (AutorizadorEC), `invoice-reconcile` (pg_cron). Todas `verify_jwt = false` con auth in-code. |

## Antes de empezar

- PRs mergeados en `main` (**BE primero**, después el FE de facturación).
- CLI: `npx -y supabase@latest …` desde el checkout del BE en `main` actualizado y
  linkeado al proyecto (el `supabase` de brew muere con exit 137). Si `@latest` se
  queja del `[inbucket]` de `config.toml` (v3 lo eliminó), usar `npx -y supabase@2`.
- Fase 0 resuelta: cuenta multiempresa de AutorizadorEC (`ak_…`), `planId` acordado,
  firma `.p12` de pruebas y taller piloto.
- **Primero staging** (`ewtduurjvgkjduhtmnzn`) con la empresa en ambiente `test`;
  prod (`qldeexeshdzrithjagqq`) recién cuando el piloto en staging autorizó.

## Paso 1 — Migraciones

```bash
npx -y supabase@latest migration list   # faltan 0049–0053 y nada más
npx -y supabase@latest db push          # cinco transacciones
```

Verificar:

```sql
select unnest(enum_range(null::public.invoice_status));        -- 6 valores
select count(*) from public.shop_billing_settings;              -- 0
select count(*) from public.shops where billing_enabled;        -- 0
select id, public from storage.buckets where id = 'invoices';  -- public = f
select jobname, schedule, active from cron.job where jobname = 'invoice-reconcile';  -- */5 * * * *
-- Las RPC de facturación NO son invocables desde el navegador:
select has_function_privilege('authenticated', 'public.get_billing_provider_key(uuid)', 'execute'),
       has_function_privilege('anon', 'public.acquire_invoice_for_emission(uuid)', 'execute');  -- f, f
-- Vault disponible para el dueño de las funciones (postgres):
select count(*) from vault.secrets;  -- no falla
```

## Paso 2 — Secrets (Dashboard → Edge Functions → Secrets)

`supabase secrets` está roto por el token de go-keyring: cargarlos a mano.

| Secret | Valor |
|---|---|
| `AUTORIZADOREC_BASE_URL` | `https://api.autorizadorec.com/api/v1` |
| `AUTORIZADOREC_ACCOUNT_KEY` | la `ak_…` de la cuenta multiempresa |
| `AUTORIZADOREC_WEBHOOK_SECRET` | un valor aleatorio largo (p. ej. `openssl rand -hex 32`) |
| `AUTORIZADOREC_PLAN_ID` | el `planId` acordado (ver `GET /client/companies/plans/available`) |
| `CRON_SECRET` | ya existe (el de `notification-dispatch`); verificar que esté |

El `AUTORIZADOREC_WEBHOOK_SECRET` se registra en cada empresa al crearla
(`billing-setup` → `save_fiscal`). **Cambiarlo después** deja a las empresas ya
creadas firmando con el viejo: hay que volver a guardar los datos fiscales de cada
taller (eso hace PATCH de la empresa con el secreto nuevo).

## Paso 3 — Deploy de las funciones (manual, no hay workflow)

```bash
npx -y supabase@latest functions deploy billing-setup     --project-ref <ref>
npx -y supabase@latest functions deploy invoice-emit      --project-ref <ref>
npx -y supabase@latest functions deploy invoice-webhook   --project-ref <ref>
npx -y supabase@latest functions deploy invoice-reconcile --project-ref <ref>
npx -y supabase@latest functions deploy technician-access --project-ref <ref>  # usa _shared/requireOwner.ts (sin cambio de comportamiento)
```

Confirmar en Dashboard → Edge Functions que las cuatro nuevas figuran con «Verify JWT»
apagado. Smoke de que rechazan sin credenciales válidas:

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/invoice-webhook" -d '{}'
# → 401 {"error":"Firma inválida."}   (500 "Configuración…" = falta el secret del Paso 2)
curl -s -X POST "https://<ref>.supabase.co/functions/v1/invoice-reconcile" -d '{}'
# → 401 {"error":"No autorizado."}
```

## Paso 4 — Cron

Igual que `trial-reminder`: si `app.cron_secret` no existe en el proyecto (en prod no
existe), reescribir el comando con URL y secret **literales**, en el editor SQL (nunca
en un archivo commiteado). El secret es el mismo del job `notification-dispatch`:
`select command from cron.job where jobname = 'notification-dispatch';`

```sql
select cron.alter_job(
  job_id  := (select jobid from cron.job where jobname = 'invoice-reconcile'),
  command := $cmd$
    select net.http_post(
      url     := 'https://<ref>.supabase.co/functions/v1/invoice-reconcile',
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', '<CRON_SECRET>'
      ),
      body    := '{}'::jsonb
    );
  $cmd$
);
```

Verificar con un tick manual (no hay facturas en vuelo: no hace nada):

```bash
curl -s -X POST "https://<ref>.supabase.co/functions/v1/invoice-reconcile" \
  -H "x-cron-secret: $CRON_SECRET" -d '{}'
# → {"scanned":0,"authorized":0,"rejected":0,"failed":0,"emitted":0,"pending":0,"errors":0}
```

Pausarlo sin tocar nada más:
`select cron.alter_job((select jobid from cron.job where jobname = 'invoice-reconcile'), active := false);`

## Paso 5 — Activar un taller

1. **Admin** (desde `/admin` cuando exista el interruptor, o SQL con service role):
   ```sql
   update public.shops set billing_enabled = true where id = '<shop_id>';
   ```
2. **Dueño**, en Configuración → Facturación electrónica:
   - Datos fiscales (`save_fiscal`): crea la empresa en AutorizadorEC en ambiente
     **`test`**, guarda su API key en Vault y crea el punto de emisión si no es `001`.
   - Firma (`upload_certificate`): el `.p12` y su clave van directo al proveedor; acá
     solo queda el vencimiento. Con eso `ready = true`.
3. Emitir una factura de prueba (SRI de pruebas) y verificar:
   ```sql
   select status, establecimiento, punto_emision, secuencial, access_key, xml_path, ride_path, error
     from public.invoices where shop_id = '<shop_id>' order by created_at desc limit 5;
   ```
   Debe quedar `authorized` con número, clave de 49 dígitos y las dos rutas. Bajar el
   RIDE desde la app (signed URL del bucket `invoices`).
4. Pasar a producción (`set_environment` → `production`; exige firma vigente y que no
   haya facturas en `processing`). La primera factura real conviene hacerla con el
   dueño al lado.

## Operación

```sql
-- facturas trabadas (las resuelve el cron; si duran > 30 min, mirar el proveedor)
select id, shop_id, provider_status, access_key, updated_at
  from public.invoices where status = 'processing' order by updated_at;
-- rechazos recientes con su mensaje del SRI
select id, shop_id, error->>'message' from public.invoices
 where status in ('rejected', 'failed') order by updated_at desc limit 20;
-- talleres listos para facturar
select s.name, b.environment, b.ready, b.cert_expires_at
  from public.shop_billing_settings b join public.shops s on s.id = b.shop_id;
```

- **Firma por vencer**: `cert_expires_at` está en `shop_billing_settings`; al vencer,
  `invoice-emit` responde 409 hasta que el dueño suba una nueva.
- **Desactivar un taller**: `billing_enabled = false`. Sus facturas en vuelo las sigue
  resolviendo el cron; el dueño ya no puede emitir ni configurar.
- **Rotar la `ak_`**: cambiar el secret en el Dashboard (las funciones lo leen en cada request; confirmar con un `status` de `billing-setup` que siga respondiendo).
- **Borrar la configuración de un taller** borra también su API key de Vault (trigger
  de `0050`); la empresa queda en AutorizadorEC y un `save_fiscal` posterior la adopta
  por RUC.

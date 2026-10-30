-- =============================================================================
-- 0048_promo_codes.sql
-- Campaña "30 días gratis por código promocional" (2026-10, acordada con Pablo y
-- Javier). Flujo: anuncio → WhatsApp → link a la landing con ?codigo=XXXX →
-- formulario → Edge Function `promo-intake` (prospecto ANÓNIMO, service_role) →
-- alta INMEDIATA del taller vía provisionTenant con provider 'trial' (0047) y N
-- días de prueba → magic link. 7 días antes de vencer, `trial-reminder` (cron
-- diario) le escribe al dueño. Al vencer, el admin suspende A MANO: NO hay corte
-- automático (misma regla que el resto de V1).
--
-- Cambios:
--   - `promo_codes`: el catálogo de códigos (uno por campaña). Lo escribe el
--     service_role (SQL editor / runbook docs/trial-promo-deploy.md); el admin
--     lo LEE desde /admin. `trial_days` vive en el código y no en la función
--     para que una campaña de 15 o 60 días sea un insert, no un deploy.
--   - `promo_redemptions`: un canje por fila (quién, con qué código, qué taller
--     salió). Es la auditoría del código: la subscription deja de decir 'trial'
--     cuando el taller paga, esto no.
--   - `subscriptions.trial_reminder_sent_at`: ancla de idempotencia del
--     recordatorio (un solo correo por prueba aunque el cron corra 7 días).
--   - cron `trial-reminder` diario, mismo patrón por settings que 0024.
--
-- Plataforma, no tenant: sin `shop_id` obligatorio ni apply_tenant_rls (el
-- canje existe ANTES que el taller). RLS activado con policies solo de admin;
-- las escrituras van por service_role (salta RLS), como manda CLAUDE.md.
-- =============================================================================

-- ---------- promo_codes ------------------------------------------------------
create table public.promo_codes (
  code        text primary key,
  trial_days  int not null default 30,
  max_uses    int,                      -- null = ilimitado
  expires_at  timestamptz,              -- null = no caduca
  active      boolean not null default true,
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Mayúsculas en la DB: la función normaliza (trim + upper) antes de buscar,
  -- así que un código guardado en minúsculas sería imposible de canjear. El
  -- check lo hace imposible de insertar en vez de silenciosamente inútil.
  constraint promo_codes_code_format_ck
    check (code = upper(code) and code ~ '^[A-Z0-9]{4,20}$'),
  -- Tope de 90: una "prueba" más larga es un regalo, y eso se hace a mano.
  constraint promo_codes_trial_days_ck check (trial_days between 1 and 90),
  constraint promo_codes_max_uses_ck check (max_uses is null or max_uses > 0)
);

create trigger set_promo_codes_updated_at before update on public.promo_codes
  for each row execute function public.set_updated_at();

-- ---------- promo_redemptions ------------------------------------------------
create table public.promo_redemptions (
  id             uuid primary key default gen_random_uuid(),
  code           text not null references public.promo_codes(code),
  email          text not null,         -- normalizado (trim + lower) por la función
  business_name  text not null,
  phone          text,                  -- tal cual lo tipeó el prospecto (trim)
  -- Se llena DESPUÉS de provisionar: la fila se inserta primero (es la que
  -- consume el cupo de max_uses) y el taller todavía no existe.
  shop_id        uuid references public.shops(id) on delete set null,
  created_at     timestamptz not null default now(),
  -- Un canje por (código, email). Nombre explícito (convención 0011): la función
  -- distingue este 23505 = "reintento del mismo prospecto" y reusa la fila en
  -- vez de fallar (doble submit, red que se corta después del insert).
  constraint promo_redemptions_code_email_unique unique (code, email)
);

-- Conteo de usos contra max_uses (count where code = ...) y listado por campaña.
-- El unique (code, email) ya empieza por code, pero se deja explícito y barato
-- para que el conteo no dependa de que alguien reordene esa constraint.
create index promo_redemptions_code_idx on public.promo_redemptions (code);

-- ---------- subscriptions: ancla del recordatorio ----------------------------
-- null = todavía no se mandó. trial-reminder la escribe con el correo OK (o
-- dry-run OK) y filtra por `is null`: un tick repetido o un retry no reenvían.
alter table public.subscriptions add column trial_reminder_sent_at timestamptz;

-- =====================================================================
-- RLS — solo admin de plataforma. Sin policy para owners/anon = sin acceso.
-- =====================================================================

alter table public.promo_codes        enable row level security;
alter table public.promo_redemptions  enable row level security;

-- FOR ALL para que /admin lo lea hoy y pueda editarlo mañana sin otra
-- migración; las altas reales las hace el service_role desde el runbook.
create policy promo_codes_admin_all on public.promo_codes
  for all to authenticated
  using ( (select private.is_platform_admin()) )
  with check ( (select private.is_platform_admin()) );

-- Solo lectura: un canje es auditoría, lo escribe exclusivamente promo-intake.
create policy promo_redemptions_admin_select on public.promo_redemptions
  for select to authenticated
  using ( (select private.is_platform_admin()) );

-- =====================================================================
-- Cron: trial-reminder diario a las 13:00 UTC = 08:00 Ecuador (sin DST).
-- Mismo patrón que 0024: URL y secret por SETTINGS de la DB, NO-OP si la URL no
-- está seteada (local / staging sin configurar). En prod el secret se pega
-- inline con cron.alter_job (ver docs/trial-promo-deploy.md).
-- =====================================================================
select cron.schedule(
  'trial-reminder',
  '0 13 * * *',
  $$
    select net.http_post(
      url     := current_setting('app.trial_reminder_url', true),
      headers := jsonb_build_object(
        'content-type', 'application/json',
        'x-cron-secret', current_setting('app.cron_secret', true)
      ),
      body    := '{}'::jsonb
    )
    where current_setting('app.trial_reminder_url', true) is not null
      and current_setting('app.trial_reminder_url', true) <> '';
  $$
);

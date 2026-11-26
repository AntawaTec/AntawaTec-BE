-- =============================================================================
-- 0056_kommo_leads.sql
-- Enlace taller ↔ lead de Kommo (CRM de marketing, 2026-11, pedido de Javier).
-- El bot de WhatsApp de la campaña manda el link de la prueba con el id del lead
-- (`antwt.com/prueba?codigo=TALLER30&lid=<id>`); la landing lo reenvía a
-- `promo-intake`, que lo guarda acá al crear el taller. Con eso el backend mueve
-- el lead en Kommo en dos momentos (ver _shared/kommo.ts):
--   - prueba activada   → etapa "Demo realizada / Prueba activa"
--   - primer pago       → etapa "Logrado con éxito"
-- y Kommo le avisa a Meta (conversiones atribuidas al anuncio).
--
-- Tabla aparte y no columnas en `shops`: `shops` la lee el dueño por RLS y el id
-- de un CRM de marketing no es dato del taller. Las dos fechas `*_synced_at` son
-- el ancla de idempotencia: null = todavía no se sincronizó (o Kommo falló y hay
-- que reintentar); con fecha = no se vuelve a llamar.
--
-- `lead_id` NO es único: un link reenviado puede dar de alta dos talleres con el
-- mismo lead, y ninguno de los dos debe fallar por eso.
-- =============================================================================

create table public.kommo_leads (
  shop_id             uuid primary key references public.shops(id) on delete cascade,
  lead_id             bigint not null,
  campaign_code       text,             -- código promocional con el que entró
  trial_synced_at     timestamptz,
  purchase_synced_at  timestamptz,
  created_at          timestamptz not null default now(),
  constraint kommo_leads_lead_id_ck check (lead_id > 0)
);

create index kommo_leads_lead_id_idx on public.kommo_leads (lead_id);

-- Plataforma, no tenant (mismo criterio que promo_redemptions, 0048): RLS
-- activado, lectura solo para el admin de Antawa, escrituras por service_role.
alter table public.kommo_leads enable row level security;

create policy kommo_leads_admin_select on public.kommo_leads
  for select to authenticated
  using ( (select private.is_platform_admin()) );

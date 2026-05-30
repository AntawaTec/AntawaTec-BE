-- =============================================================================
-- 0006_appointments.sql
-- Appointments: created from an approved quote or manually (walk-in).
-- WhatsApp reminders (appointment_confirmed / appointment_reminder_24h) are
-- dispatched by Edge Functions, not DB triggers.
-- =============================================================================

create table public.appointments (
  id           uuid primary key default gen_random_uuid(),
  shop_id      uuid not null references public.shops(id) on delete cascade,
  customer_id  uuid not null references public.customers(id) on delete restrict,
  vehicle_id   uuid not null references public.vehicles(id)  on delete restrict,
  quote_id     uuid references public.quotes(id) on delete set null,  -- nullable: walk-ins
  scheduled_at timestamptz not null,
  status       public.appointment_status not null default 'scheduled',
  source       public.appointment_source not null default 'walk_in',
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index appointments_shop_id_idx      on public.appointments (shop_id);
create index appointments_customer_id_idx  on public.appointments (customer_id);
create index appointments_vehicle_id_idx   on public.appointments (vehicle_id);
create index appointments_scheduled_at_idx on public.appointments (scheduled_at);

create trigger set_appointments_updated_at before update on public.appointments
  for each row execute function public.set_updated_at();

-- RLS — standard tenant pattern
select private.apply_tenant_rls('appointments');

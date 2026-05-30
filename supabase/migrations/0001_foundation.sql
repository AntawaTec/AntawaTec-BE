-- =============================================================================
-- 0001_foundation.sql
-- Foundation: enum types, shared updated_at trigger, private schema.
-- No table references here, so this migration is safe to run first.
-- Target: Supabase Postgres (PG15+). gen_random_uuid() is core in PG13+.
-- =============================================================================

-- ---------- Private schema (RLS helpers live here, never exposed via API) -----
create schema if not exists private;

-- ---------- Enum types --------------------------------------------------------
create type public.shop_status            as enum ('pending', 'active', 'suspended');
create type public.user_role              as enum ('antawa_admin', 'shop_owner');

create type public.quote_status           as enum ('draft', 'approved', 'rejected');
create type public.quote_section_type     as enum ('maintenance', 'bodywork');
create type public.quote_item_type        as enum ('part', 'labor');

create type public.appointment_status     as enum ('scheduled', 'confirmed', 'completed', 'cancelled');
create type public.appointment_source     as enum ('quote', 'walk_in');

create type public.work_order_status      as enum ('reception', 'quote', 'in_process', 'delivery', 'historical');
create type public.work_order_media_type  as enum ('photo', 'video');

create type public.inventory_movement_type as enum ('purchase', 'consumption', 'adjustment');

create type public.subscription_provider  as enum ('hotmart', 'bank_transfer');
create type public.subscription_status    as enum ('active', 'past_due', 'cancelled');
create type public.bank_transfer_status   as enum ('pending', 'approved', 'rejected');

create type public.notification_channel   as enum ('whatsapp', 'email');
create type public.notification_template  as enum (
  'appointment_confirmed',
  'appointment_reminder_24h',
  'vehicle_received',
  'quote_ready',
  'vehicle_ready',
  'delivery_completed'
);
create type public.notification_status    as enum ('queued', 'sent', 'delivered', 'failed');

create type public.migration_decision     as enum ('pending', 'go', 'no_go');

-- ---------- Shared updated_at trigger function --------------------------------
-- Attached to every table that has an updated_at column.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

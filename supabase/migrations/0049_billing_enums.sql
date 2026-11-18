-- =============================================================================
-- 0049_billing_enums.sql
-- Facturación electrónica SRI (v1: solo factura) — tipos.
--
-- Solo los `create type`, aislados del resto del lote (0050–0053) para que el
-- tipo exista antes de cualquier tabla/columna que lo use. Un tipo NUEVO sí podría
-- usarse en la misma migración (la restricción de 0016 es para `ADD VALUE`), pero
-- separarlos deja cada archivo con un solo concern, como pide CLAUDE.md.
--
-- invoice_status — ciclo de vida de una factura en NUESTRA base (no el del SRI):
--   draft       borrador editable por el dueño (único estado que la RLS le deja
--               escribir, ver 0051).
--   processing  lock tomado por `invoice-emit` (acquire_invoice_for_emission) o
--               emisión enviada al proveedor SIN respuesta definitiva todavía.
--               La resuelve el webhook o `invoice-reconcile`.
--   authorized  el SRI la autorizó: hay número, clave de acceso y autorización.
--   rejected    el SRI la rechazó (DEVUELTA / NO AUTORIZADO): mensajes en `error`.
--   failed      no se pudo emitir y el proveedor NO tiene un documento vivo
--               (validación 4xx, credenciales, o el proveedor se rindió).
--   voided      el dueño la anuló en el portal del SRI y la marcó en la app.
--
-- buyer_id_type — tipo de identificación del comprador. El código SRI (tabla 6:
--   04 RUC, 05 cédula, 06 pasaporte, 07 consumidor final, 08 exterior) se deriva
--   en código (_shared/billing/sri.ts); la base guarda el nombre legible.
-- =============================================================================

create type public.invoice_status as enum (
  'draft',
  'processing',
  'authorized',
  'rejected',
  'failed',
  'voided'
);

create type public.buyer_id_type as enum (
  'ruc',
  'cedula',
  'pasaporte',
  'exterior',
  'consumidor_final'
);

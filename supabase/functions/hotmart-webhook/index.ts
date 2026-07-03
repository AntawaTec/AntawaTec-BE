// =============================================================================
// hotmart-webhook/index.ts
// Receptor del webhook de pago de Hotmart (Webhook/Postback 2.0). Puerta de
// entrada del embudo: compra en Hotmart -> provisioning idempotente -> magic link.
//
// La lógica replica la ESPECIFICACIÓN del sistema Zoho actual (script Deluge), no
// se porta tal cual. Reúsa `provisionTenant` (idempotente y re-entrante, con las
// UNIQUE de 0011 detrás) y agrega el ciclo de vida (reactivación / suspensión).
//
// Ruteo de eventos:
//   PURCHASE_APPROVED / PURCHASE_COMPLETE -> provisionTenant + reactivar (active/active).
//   PURCHASE_REFUNDED                     -> suspender (shop suspended, sub cancelled).
//   PURCHASE_CANCELED                     -> no desactiva (baja diferida); solo procesa.
//   cualquier otro                        -> ignora (se registra para auditoría).
//
// Orden estricto: hottok ANTES de cualquier escritura; idempotencia (insert-first
// en webhook_events) ANTES de procesar. Responde 200 salvo 401 (hottok), 400 (body
// no-JSON), 405 (método) y 500 (error transitorio -> Hotmart reintenta hasta 5x).
//
// Lógica de ciclo de vida en la función, NO en triggers de DB (CLAUDE.md).
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  badRequest,
  methodNotAllowed,
  ok,
  serverError,
  unauthorized,
} from "../_shared/response.ts";
import { provisionTenant } from "../_shared/provisionTenant.ts";

const PROVIDER = "hotmart" as const;
const APPROVED_EVENTS = new Set(["PURCHASE_APPROVED", "PURCHASE_COMPLETE"]);
const REFUNDED_EVENT = "PURCHASE_REFUNDED";
const CANCELED_EVENT = "PURCHASE_CANCELED";

// --- Forma (parcial) del payload de Hotmart 2.0 -----------------------------
interface HotmartPayload {
  id?: string;
  event?: string;
  hottok?: string;
  data?: {
    buyer?: { name?: string; email?: string };
    purchase?: { transaction?: string };
    product?: { name?: string };
  };
  [key: string]: unknown;
}

interface ParsedEvent {
  event: string;
  externalId: string; // SIEMPRE no-null (hash determinista como último recurso)
  externalIdSource: "id" | "transaction" | "payload_hash";
  email: string;
  businessName: string;
}

// --- Entrada HTTP ------------------------------------------------------------

Deno.serve(async (req) => {
  if (req.method !== "POST") return methodNotAllowed();

  // 1) Raw body + JSON.
  let body: HotmartPayload;
  let raw: string;
  try {
    raw = await req.text();
    body = JSON.parse(raw) as HotmartPayload;
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }

  // 2) Auth: hottok del body contra el secret, en tiempo constante. ANTES de escribir.
  const expectedHottok = Deno.env.get("HOTMART_HOTTOK") ?? "";
  if (
    !expectedHottok ||
    !timingSafeEqual(String(body.hottok ?? ""), expectedHottok)
  ) {
    return unauthorized("hottok inválido.");
  }

  // 3) Parse del payload (con external_id garantizado no-null).
  const parsed = await parsePayload(body, raw);

  // A partir de aquí podemos escribir: cliente service_role.
  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error("hotmart-webhook: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  try {
    // 4) Idempotencia primero (insert-first en webhook_events).
    const dedup = await recordWebhookEvent(admin, parsed, body);
    if (dedup.alreadyProcessed) {
      return ok({ status: "duplicate_ignored", externalId: parsed.externalId });
    }

    // 5) Validar email. Inválido => irreparable: marca procesado y 200 (no reintentar).
    if (!isValidEmail(parsed.email)) {
      console.warn(
        `hotmart-webhook: email inválido. event=${parsed.event} ` +
          `externalId=${parsed.externalId} email="${parsed.email}"`,
      );
      await markProcessed(admin, dedup.id, null);
      return ok({ status: "invalid_email_ignored" });
    }

    // 6) Rutear por tipo de evento.
    let shopId: string | null = null;

    if (APPROVED_EVENTS.has(parsed.event)) {
      const result = await provisionTenant(admin, {
        businessName: parsed.businessName,
        email: parsed.email,
        provider: PROVIDER,
        redirectTo: Deno.env.get("ONBOARDING_REDIRECT_URL") || undefined,
      });
      shopId = result.shopId;
      await reactivate(admin, shopId);
      console.log(
        `hotmart-webhook: APPROVED procesado. event=${parsed.event} ` +
          `email=${parsed.email} shop=${shopId} created=${result.created}`,
      );
    } else if (parsed.event === REFUNDED_EVENT) {
      shopId = await suspend(admin, parsed.email);
      console.log(
        `hotmart-webhook: REFUNDED procesado. email=${parsed.email} ` +
          `shop=${shopId ?? "no encontrado (reembolso sin usuario)"}`,
      );
    } else if (parsed.event === CANCELED_EVENT) {
      // Baja diferida del sistema actual: no se desactiva aquí.
      console.log(
        `hotmart-webhook: CANCELED recibido; no se desactiva (baja diferida). ` +
          `email=${parsed.email}`,
      );
    } else {
      console.log(
        `hotmart-webhook: evento ignorado. event=${parsed.event} ` +
          `externalId=${parsed.externalId}`,
      );
    }

    // 7) Cierre: marcar procesado (y enlazar shop si lo hubo).
    await markProcessed(admin, dedup.id, shopId);
    return ok({ status: "processed", event: parsed.event, shopId });
  } catch (e) {
    // 8) Error transitorio: 500 para que Hotmart reintente. La fila queda
    //    processed=false; el reintento re-procesa (todo es idempotente/re-entrante).
    console.error(
      `hotmart-webhook: error procesando event=${parsed.event} ` +
        `externalId=${parsed.externalId}:`,
      e,
    );
    return serverError("Error procesando el webhook.");
  }
});

// --- Hotmart: específico del proveedor (aislado, principio 7 de CLAUDE.md) ---

/**
 * Parsea el payload de Hotmart. Garantiza un `externalId` NO nulo:
 * `id` del evento -> `data.purchase.transaction` -> hash SHA-256 del raw body.
 * El hash cierra el borde en que faltan ambos ids: como Postgres trata los NULL
 * como distintos en un UNIQUE, un external_id null rompería la deduplicación de
 * `unique(provider, external_id)` en silencio. Un payload idéntico hashea igual,
 * así que un duplicado real sigue colapsando a la misma fila.
 */
async function parsePayload(
  body: HotmartPayload,
  raw: string,
): Promise<ParsedEvent> {
  const event = String(body.event ?? "").trim();
  const email = normalizeEmail(body.data?.buyer?.email);
  const businessName = (body.data?.buyer?.name ?? "").trim() || "Nuevo Taller";

  const idCandidate = String(body.id ?? "").trim();
  const txCandidate = String(body.data?.purchase?.transaction ?? "").trim();

  let externalId: string;
  let externalIdSource: ParsedEvent["externalIdSource"];
  if (idCandidate) {
    externalId = idCandidate;
    externalIdSource = "id";
  } else if (txCandidate) {
    externalId = txCandidate;
    externalIdSource = "transaction";
  } else {
    externalId = "sha256:" + (await sha256Hex(raw));
    externalIdSource = "payload_hash";
    console.warn(
      `hotmart-webhook: webhook sin id ni transaction; external_id derivado por ` +
        `hash del payload para preservar idempotencia. event=${event}`,
    );
  }

  return { event, externalId, externalIdSource, email, businessName };
}

// --- webhook_events: idempotencia -------------------------------------------

/**
 * Registra el evento (insert-first) apoyándose en `unique(provider, external_id)`.
 * - Insert OK            -> primera entrega; devuelve { id, alreadyProcessed:false }.
 * - 23505 (duplicado)    -> relee la fila: si `processed` ya está, no reprocesar;
 *                           si no, una entrega previa quedó a medias -> reprocesar
 *                           (seguro: provisionTenant y los cambios de estado son
 *                           idempotentes y race-safe).
 */
async function recordWebhookEvent(
  admin: SupabaseClient,
  parsed: ParsedEvent,
  payload: HotmartPayload,
): Promise<{ id: string; alreadyProcessed: boolean }> {
  const { data, error } = await admin
    .from("webhook_events")
    .insert({
      provider: PROVIDER,
      event_type: parsed.event,
      external_id: parsed.externalId,
      payload,
      processed: false,
    })
    .select("id")
    .single();

  if (!error && data) {
    return { id: data.id, alreadyProcessed: false };
  }

  if (error?.code === "23505") {
    const { data: existing, error: selErr } = await admin
      .from("webhook_events")
      .select("id, processed")
      .eq("provider", PROVIDER)
      .eq("external_id", parsed.externalId)
      .single();
    if (selErr) {
      throw new Error(`Lectura de webhook_event duplicado falló: ${selErr.message}`);
    }
    return { id: existing.id, alreadyProcessed: existing.processed === true };
  }

  throw new Error(
    `No se pudo registrar webhook_event: ${error?.message ?? "desconocido"}`,
  );
}

async function markProcessed(
  admin: SupabaseClient,
  id: string,
  shopId: string | null,
): Promise<void> {
  const patch: Record<string, unknown> = { processed: true };
  if (shopId) patch.shop_id = shopId;
  const { error } = await admin.from("webhook_events").update(patch).eq("id", id);
  if (error) {
    throw new Error(`No se pudo marcar webhook_event procesado: ${error.message}`);
  }
}

// --- Ciclo de vida del taller (lógica de app, no triggers de DB) -------------

/**
 * Reactivación tras compra aprobada. Idempotente: cubre tanto el alta nueva
 * (provisionTenant ya dejó todo en 'active') como la reactivación de un taller
 * suspendido por un refund previo. NO recalcula current_period_end (regla "no
 * calcular vencimiento por plan").
 */
async function reactivate(admin: SupabaseClient, shopId: string): Promise<void> {
  const { data: shop, error: selErr } = await admin
    .from("shops")
    .select("activated_at")
    .eq("id", shopId)
    .single();
  if (selErr) throw new Error(`Lectura de shop falló: ${selErr.message}`);

  const shopPatch: Record<string, unknown> = { status: "active" };
  if (!shop.activated_at) shopPatch.activated_at = new Date().toISOString();

  const { error: shopErr } = await admin
    .from("shops")
    .update(shopPatch)
    .eq("id", shopId);
  if (shopErr) throw new Error(`No se pudo reactivar el shop: ${shopErr.message}`);

  const { error: subErr } = await admin
    .from("subscriptions")
    .update({ status: "active" })
    .eq("shop_id", shopId)
    .eq("provider", PROVIDER);
  if (subErr) throw new Error(`No se pudo activar la subscription: ${subErr.message}`);
}

/**
 * Suspensión tras reembolso (no destructiva). Localiza el taller por
 * `shops.contact_email` (UNIQUE desde 0011). Si no hay taller para ese email,
 * devuelve null (el caller lo loguea como "reembolso sin usuario"). No toca auth
 * ni profiles.
 */
async function suspend(
  admin: SupabaseClient,
  email: string,
): Promise<string | null> {
  const { data: shop, error: selErr } = await admin
    .from("shops")
    .select("id")
    .eq("contact_email", email)
    .maybeSingle();
  if (selErr) throw new Error(`Búsqueda de shop por email falló: ${selErr.message}`);
  if (!shop) return null;

  const { error: shopErr } = await admin
    .from("shops")
    .update({ status: "suspended" })
    .eq("id", shop.id);
  if (shopErr) throw new Error(`No se pudo suspender el shop: ${shopErr.message}`);

  const { error: subErr } = await admin
    .from("subscriptions")
    .update({ status: "cancelled" })
    .eq("shop_id", shop.id)
    .eq("provider", PROVIDER);
  if (subErr) throw new Error(`No se pudo cancelar la subscription: ${subErr.message}`);

  return shop.id;
}

// --- Utilidades --------------------------------------------------------------

/** Comparación de strings en tiempo constante (evita timing attacks sobre el hottok). */
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeEmail(email?: string): string {
  return String(email ?? "").trim().toLowerCase();
}

/** Validación mínima alineada con la especificación (Deluge): no vacío, con @ y con punto. */
function isValidEmail(email: string): boolean {
  return email.length > 0 && email.includes("@") && email.includes(".");
}

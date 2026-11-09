// =============================================================================
// invoice-reconcile/index.ts
// Cron (pg_cron cada 5 min, job `invoice-reconcile` de 0053): resuelve las
// facturas que quedaron en 'processing' — la emisión síncrona no tuvo respuesta
// definitiva (timeout, 5xx, el SRI no contestó) o el webhook no llegó.
//
// Solo mira filas 'processing' con updated_at de hace más de 2 minutos (una
// emisión en curso tarda < 2 min: 15 s de consulta + 30 s de emisión + archivos),
// las más viejas primero, de a BATCH por corrida. No barre histórico: no hay
// nada que sembrar antes de deployarla (a diferencia de 0041/0044).
//
// Por cada fila consulta al proveedor por idempotencyKey (= invoices.id):
//   - no existe (404)     → la factura nunca llegó: se emite ahora (misma ruta
//                           que invoice-emit, misma idempotencyKey).
//   - AUTHORIZED/REJECTED → se asienta (y se archivan XML/RIDE si autorizó).
//   - FAILED              → el proveedor la está reintentando; si sigue FAILED
//                           después de FAILED_GRACE_MS se marca 'failed' (el
//                           dueño la reabre o reintenta; la próxima emisión
//                           CORRIGE el mismo documento, no crea otro número).
//   - en proceso          → se guarda el estado crudo y se espera.
//   - error de red        → se deja para la próxima corrida.
//
// Auth: header x-cron-secret == CRON_SECRET. A diferencia de
// notification-dispatch, si CRON_SECRET NO está configurado la función RECHAZA
// la llamada (500): no hay modo "invocación directa sin secret" para algo que
// emite comprobantes fiscales.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import { json, methodNotAllowed, ok, serverError, unauthorized } from "../_shared/response.ts";
import { timingSafeEqual } from "../_shared/deliveryReceipts.ts";
import { MISSING_CONFIG_MESSAGE, providerFromEnv } from "../_shared/billing/config.ts";
import {
  applyEmissionResult,
  emitLocked,
  getProviderKey,
  INVOICE_COLUMNS,
  type InvoiceRow,
  loadSettings,
  type SettingsRow,
  storeInvoiceFiles,
} from "../_shared/billing/invoiceStore.ts";
import type { BillingProvider } from "../_shared/billing/provider.ts";

const LABEL = "invoice-reconcile";
const STALE_MS = 2 * 60_000;
const FAILED_GRACE_MS = 30 * 60_000;
const BATCH = 25;

Deno.serve(async (req) => {
  if (req.method !== "POST") return methodNotAllowed();

  const cronSecret = (Deno.env.get("CRON_SECRET") ?? "").trim();
  if (!cronSecret) {
    console.error(`${LABEL}: falta CRON_SECRET; se rechaza la invocación.`);
    return serverError(MISSING_CONFIG_MESSAGE);
  }
  if (!timingSafeEqual(req.headers.get("x-cron-secret") ?? "", cronSecret)) {
    return unauthorized("No autorizado.");
  }

  const provider = providerFromEnv();
  if (!provider) {
    console.error(`${LABEL}: faltan AUTORIZADOREC_BASE_URL / AUTORIZADOREC_ACCOUNT_KEY.`);
    return serverError(MISSING_CONFIG_MESSAGE);
  }
  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const { data, error } = await admin
    .from("invoices")
    .select(INVOICE_COLUMNS)
    .eq("status", "processing")
    .lt("updated_at", cutoff)
    .order("updated_at", { ascending: true })
    .range(0, BATCH - 1);
  if (error) {
    console.error(`${LABEL}: lectura de facturas en emisión falló:`, error.message);
    return json(500, { error: "No se pudieron leer las facturas en emisión." });
  }

  const summary = { scanned: 0, authorized: 0, rejected: 0, failed: 0, emitted: 0, pending: 0, errors: 0 };
  const settingsCache = new Map<string, SettingsRow | null>();
  const keyCache = new Map<string, string | null>();

  for (const row of (data ?? []) as unknown as InvoiceRow[]) {
    summary.scanned++;
    try {
      const status = await reconcileOne(admin, provider, row, settingsCache, keyCache);
      summary[status]++;
    } catch (e) {
      summary.errors++;
      console.error(`${LABEL}: factura ${row.id}:`, e instanceof Error ? e.message : e);
    }
  }
  if (summary.scanned > 0) console.log(`${LABEL}:`, JSON.stringify(summary));
  return ok(summary);
});

type Tally = "authorized" | "rejected" | "failed" | "emitted" | "pending";

async function reconcileOne(
  admin: SupabaseClient,
  provider: BillingProvider,
  row: InvoiceRow,
  settingsCache: Map<string, SettingsRow | null>,
  keyCache: Map<string, string | null>,
): Promise<Tally> {
  if (!keyCache.has(row.shop_id)) keyCache.set(row.shop_id, await getProviderKey(admin, row.shop_id));
  const apiKey = keyCache.get(row.shop_id) ?? null;
  if (!apiKey) {
    await applyEmissionResult(admin, row.id, {
      outcome: "failed",
      document: null,
      message: "El taller no tiene credencial del proveedor de facturación. Revisá la configuración.",
    }, ["processing"]);
    return "failed";
  }

  const found = await provider.findDocument(apiKey, row.id); // lanza ante red → próxima corrida

  if (!found) {
    // Nunca llegó al proveedor: emitir ahora (la fila sigue 'processing' = lock nuestro).
    if (!settingsCache.has(row.shop_id)) settingsCache.set(row.shop_id, await loadSettings(admin, row.shop_id));
    const settings = settingsCache.get(row.shop_id);
    if (!settings) {
      await applyEmissionResult(admin, row.id, {
        outcome: "failed",
        document: null,
        message: "El taller no tiene configuración de facturación.",
      }, ["processing"]);
      return "failed";
    }
    const out = await emitLocked(admin, provider, apiKey, row.id, settings);
    if (out.kind === "invalid") {
      await admin.from("invoices").update({
        status: "failed",
        error: { source: "validation", message: out.errors[0], details: out.errors, at: new Date().toISOString() },
      }).eq("id", row.id).eq("status", "processing");
      return "failed";
    }
    const st = out.row?.status;
    return st === "authorized" || st === "rejected" || st === "failed" ? st : "emitted";
  }

  if (found.outcome === "authorized" || found.outcome === "rejected") {
    const updated = await applyEmissionResult(admin, row.id, found, ["processing"]);
    if (updated?.status === "authorized") await storeInvoiceFiles(admin, provider, apiKey, updated);
    return found.outcome;
  }

  // En proceso en el proveedor (CREATED / PROCESSING / RECEIVED / FAILED).
  const doc = found.document;
  const stalledMs = Date.now() - Date.parse(row.updated_at);
  if (doc?.status === "FAILED" && row.provider_status === "FAILED" && stalledMs > FAILED_GRACE_MS) {
    // VERIFICAR EN SANDBOX: cuánto tarda el proveedor en agotar sus reintentos
    // (la guía: hasta 10 con esperas crecientes) y si siempre manda document.failed.
    await applyEmissionResult(admin, row.id, {
      outcome: "failed",
      document: doc,
      message: "El SRI no respondió después de varios reintentos. Volvé a emitir la factura más tarde.",
    }, ["processing"]);
    return "failed";
  }
  // Guardar el estado crudo SOLO si cambió (si no, updated_at se movería en cada
  // corrida y FAILED_GRACE_MS nunca se cumpliría).
  if (
    doc && (doc.status !== row.provider_status || (doc.accessKey && doc.accessKey !== row.access_key) ||
      (doc.providerId && doc.providerId !== row.provider_document_id))
  ) {
    await applyEmissionResult(admin, row.id, found, ["processing"]);
  }
  return "pending";
}

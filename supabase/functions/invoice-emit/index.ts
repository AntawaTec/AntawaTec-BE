// =============================================================================
// invoice-emit/index.ts
// Emisión de facturas electrónicas, invocada por el DUEÑO desde la PWA.
//
// Acciones (body JSON { action, invoiceId }):
//   - emit:          borrador (o 'failed') → proveedor → authorized / rejected /
//                    failed / processing. Ver el flujo abajo.
//   - reopen:        rejected | failed → draft (limpia el error y lo que asignó el
//                    proveedor) para "Corregir y reintentar".
//   - mark_voided:   authorized → voided. La anulación se hace en el portal del SRI;
//                    esto solo la registra en la app (v1).
//   - refresh_files: vuelve a bajar XML/RIDE de una factura autorizada cuyas rutas
//                    quedaron en NULL (la descarga posterior a autorizar es best-effort).
//
// Flujo de `emit`:
//   1. Auth (dueño) + taller con billing_enabled + configuración lista y firma
//      vigente + credenciales del proveedor (si faltan: 500, NO hay dry-run).
//   2. Factura filtrada por el shop_id del PERFIL (404 uniforme si es de otro).
//   3. Pre-validación barata (400 sin tocar el estado).
//   4. Lock atómico acquire_invoice_for_emission: draft|failed → processing. Un
//      doble clic recibe 409. Con el lock tomado se mira si la orden enlazada
//      está ANULADA (0055): si lo está, se libera el lock y 409.
//   5. Se fijan fecha (hoy, Ecuador), ambiente y serie; se RELEEN factura e ítems
//      (lo que quedó congelado por el lock) y se recalculan los totales en
//      servidor. Si no cuadran: el lock vuelve al estado anterior y 400.
//   6. Proveedor con idempotencyKey = invoice.id; se asienta el resultado. Sin
//      respuesta definitiva queda 'processing' (lo resuelve el webhook o el cron).
//   7. Si quedó autorizada, se archivan XML y RIDE en el bucket (best-effort).
//
// Seguridad: verify_jwt = false (preflight CORS), auth real in-code vía
// _shared/requireOwner.ts. Toda lectura/escritura se filtra por el shop_id del
// perfil del caller, nunca por uno que venga en el body.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import { requireShopOwner } from "../_shared/requireOwner.ts";
import { badRequest, forbidden, json, methodNotAllowed, notFound, ok, preflight, serverError } from "../_shared/response.ts";
import { MISSING_CONFIG_MESSAGE, providerFromEnv } from "../_shared/billing/config.ts";
import {
  certValid,
  emitLocked,
  getProviderKey,
  INVOICE_COLUMNS,
  type InvoiceRow,
  invoiceView,
  loadInvoice,
  loadItems,
  loadSettings,
  prepareEmission,
  shopBillingEnabled,
  storeInvoiceFiles,
} from "../_shared/billing/invoiceStore.ts";
import { ecToday } from "../_shared/billing/sri.ts";

const LABEL = "invoice-emit";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Action = "emit" | "reopen" | "mark_voided" | "refresh_files";
const ACTIONS: Action[] = ["emit", "reopen", "mark_voided", "refresh_files"];

const STATUS_LABEL: Record<string, string> = {
  draft: "un borrador",
  processing: "en emisión",
  authorized: "autorizada",
  rejected: "rechazada",
  failed: "con error de emisión",
  voided: "anulada",
};

const conflict = (message: string, row?: InvoiceRow | null) =>
  json(409, { error: message, ...(row ? { invoice: invoiceView(row) } : {}) });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  const owner = await requireShopOwner(admin, req, LABEL, "Solo el dueño del taller puede emitir facturas.");
  if (!owner.ok) return owner.response;
  const { shopId } = owner;

  let body: { action?: string; invoiceId?: string };
  try {
    body = await req.json();
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }
  const action = body.action as Action;
  if (!ACTIONS.includes(action)) {
    return badRequest("action debe ser 'emit', 'reopen', 'mark_voided' o 'refresh_files'.");
  }
  const invoiceId = typeof body.invoiceId === "string" ? body.invoiceId.trim() : "";
  if (!UUID_RE.test(invoiceId)) return badRequest("Falta invoiceId (uuid).");

  try {
    if (!(await shopBillingEnabled(admin, shopId))) {
      return forbidden("La facturación electrónica no está activada para tu taller.");
    }
    const invoice = await loadInvoice(admin, invoiceId, shopId);
    if (!invoice) return notFound("No encontramos esa factura en tu taller.");

    switch (action) {
      case "emit":
        return await emit(admin, shopId, invoice);
      case "reopen":
        return await reopen(admin, shopId, invoice);
      case "mark_voided":
        return await markVoided(admin, shopId, invoice);
      case "refresh_files":
        return await refreshFiles(admin, shopId, invoice);
    }
  } catch (e) {
    console.error(`${LABEL}: error en ${action} de la factura ${invoiceId}:`, e instanceof Error ? e.message : e);
    return serverError("No se pudo completar la operación. Intenta de nuevo.");
  }
});

// --------------------------------------------------------------------- emit --

async function emit(admin: SupabaseClient, shopId: string, invoice: InvoiceRow): Promise<Response> {
  if (invoice.status !== "draft" && invoice.status !== "failed") {
    return conflict(`La factura está ${STATUS_LABEL[invoice.status] ?? invoice.status}; no se puede emitir.`, invoice);
  }

  const provider = providerFromEnv();
  if (!provider) {
    console.error(`${LABEL}: faltan AUTORIZADOREC_BASE_URL / AUTORIZADOREC_ACCOUNT_KEY.`);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  const nowMs = Date.now();
  const settings = await loadSettings(admin, shopId);
  if (!settings || !settings.provider_company_id) {
    return conflict("Completa los datos fiscales y sube la firma electrónica en Configuración antes de facturar.");
  }
  if (!certValid(settings, nowMs)) {
    return conflict("La firma electrónica está vencida o no fue cargada. Sube una vigente en Configuración.");
  }
  if (!settings.ready) {
    return conflict("La configuración de facturación está incompleta. Revísala en Configuración.");
  }
  const apiKey = await getProviderKey(admin, shopId);
  if (!apiKey) {
    console.error(`${LABEL}: taller ${shopId} con settings.ready pero sin API key en Vault.`);
    return conflict("La configuración de facturación está incompleta. Vuelve a guardar los datos fiscales.");
  }

  // 3) Pre-validación sin lock (con la fecha y serie que se van a usar).
  const issuedOn = ecToday(nowMs);
  const preview = prepareEmission(
    { ...invoice, issued_on: issuedOn, establecimiento: settings.establecimiento, punto_emision: settings.punto_emision },
    await loadItems(admin, invoice.id),
    settings,
  );
  if (!preview.ok) return json(400, { error: preview.errors[0], details: preview.errors });

  // 4) Lock atómico.
  const { data: acquired, error: lockErr } = await admin.rpc("acquire_invoice_for_emission", { p_id: invoice.id });
  if (lockErr) throw new Error(`acquire_invoice_for_emission falló: ${lockErr.message}`);
  const lock = Array.isArray(acquired) ? acquired[0] : acquired;
  if (lock && lock.shop_id !== shopId) {
    // Imposible (la factura se leyó filtrada por shop_id y el id es PK), pero si
    // pasara no se deja trabada una factura ajena.
    await releaseLock(admin, invoice.id, lock.previous_status);
    return json(404, { error: "No encontramos esa factura en tu taller." });
  }
  if (!lock) {
    const fresh = await loadInvoice(admin, invoice.id, shopId);
    return conflict("Esta factura ya se está emitiendo o ya fue emitida. Recarga para ver su estado.", fresh);
  }
  const previous = lock.previous_status as "draft" | "failed";

  // 4b) Orden anulada (0055). Se mira DESPUÉS del lock a propósito: void_work_order
  // bloquea las facturas de la orden `for update`, así que si el anulado ganó la
  // carrera, esta lectura ya lo ve committeado; si ganó el lock, el anulado ve la
  // factura en 'processing' y se rechaza. Un chequeo antes del lock no cerraría
  // la carrera (solo ahorraría el ida y vuelta), por eso no lo hay.
  // La orden se lee de la factura RELEÍDA: con el lock tomado ya no cambia.
  let voided: boolean;
  try {
    const locked = await loadInvoice(admin, invoice.id, shopId);
    voided = await workOrderVoided(admin, (locked?.work_order_id as string | null) ?? null, shopId);
  } catch (e) {
    await releaseLock(admin, invoice.id, previous);
    throw e;
  }
  if (voided) {
    await releaseLock(admin, invoice.id, previous);
    const fresh = await loadInvoice(admin, invoice.id, shopId);
    return conflict("La orden de esta factura está anulada. Reactívala para poder facturarla.", fresh);
  }

  // 5) Congelar fecha, ambiente y serie de ESTA emisión.
  const { error: stampErr } = await admin
    .from("invoices")
    .update({
      issued_on: issuedOn,
      environment: settings.environment,
      establecimiento: settings.establecimiento,
      punto_emision: settings.punto_emision,
    })
    .eq("id", invoice.id)
    .eq("status", "processing");
  if (stampErr) {
    await releaseLock(admin, invoice.id, previous);
    throw new Error(`No se pudo preparar la emisión: ${stampErr.message}`);
  }

  // 6–7) Emisión (relee, valida, proveedor, asienta, archiva).
  let outcome;
  try {
    outcome = await emitLocked(admin, provider, apiKey, invoice.id, settings);
  } catch (e) {
    // Un error NUESTRO (DB) después de tomar el lock: no se sabe si el proveedor
    // ya recibió la factura, así que NO se libera el lock. Queda 'processing' y
    // invoice-reconcile la resuelve consultando por idempotencyKey.
    console.error(`${LABEL}: error emitiendo ${invoice.id} (queda processing):`, e instanceof Error ? e.message : e);
    const fresh = await loadInvoice(admin, invoice.id, shopId).catch(() => null);
    return json(202, {
      error: "La factura quedó en emisión; en unos minutos se actualiza su estado.",
      ...(fresh ? { invoice: invoiceView(fresh) } : {}),
    });
  }

  if (outcome.kind === "invalid") {
    await releaseLock(admin, invoice.id, previous);
    return json(400, { error: outcome.errors[0], details: outcome.errors });
  }

  const row = outcome.row ?? (await loadInvoice(admin, invoice.id, shopId));
  console.log(`${LABEL}: factura ${invoice.id} → ${row?.status} (${outcome.result.outcome}).`);
  return ok({
    invoice: row ? invoiceView(row) : null,
    outcome: outcome.result.outcome,
    message: outcome.result.message ?? outcome.result.notice ?? null,
  });
}

/** ¿La orden enlazada a la factura está anulada (0055)? Sin orden → false. */
async function workOrderVoided(admin: SupabaseClient, workOrderId: string | null, shopId: string): Promise<boolean> {
  if (!workOrderId) return false;
  const { data, error } = await admin
    .from("work_orders")
    .select("voided_at")
    .eq("id", workOrderId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`Lectura de la orden ${workOrderId} falló: ${error.message}`);
  return Boolean(data?.voided_at);
}

/** Devuelve el lock al estado previo (solo si sigue siendo nuestro 'processing'). */
async function releaseLock(admin: SupabaseClient, id: string, previous: "draft" | "failed"): Promise<void> {
  const { error } = await admin.from("invoices").update({ status: previous }).eq("id", id).eq("status", "processing");
  if (error) console.error(`${LABEL}: no se pudo liberar el lock de ${id}:`, error.message);
}

// ------------------------------------------------------------------- reopen --

async function reopen(admin: SupabaseClient, shopId: string, invoice: InvoiceRow): Promise<Response> {
  if (invoice.status === "draft") return ok({ invoice: invoiceView(invoice), alreadyDraft: true });
  if (invoice.status !== "rejected" && invoice.status !== "failed") {
    return conflict(`La factura está ${STATUS_LABEL[invoice.status] ?? invoice.status}; solo se corrige una rechazada o con error.`, invoice);
  }
  // Vuelve a borrador con TODO lo que asignó el proveedor en NULL: es lo que exige
  // la RLS del dueño para dejarlo editar. El documento rechazado sigue existiendo
  // en el proveedor bajo la misma idempotencyKey: la próxima emisión lo encuentra
  // y lo CORRIGE (PUT) en vez de crear otro número.
  const { data, error } = await admin
    .from("invoices")
    .update({
      status: "draft",
      error: null,
      provider_status: null,
      provider_document_id: null,
      access_key: null,
      secuencial: null,
      authorization_number: null,
      authorized_at: null,
      xml_path: null,
      ride_path: null,
    })
    .eq("id", invoice.id)
    .eq("shop_id", shopId)
    .in("status", ["rejected", "failed"])
    .select(INVOICE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`reopen falló: ${error.message}`);
  if (!data) {
    const fresh = await loadInvoice(admin, invoice.id, shopId);
    return conflict("La factura cambió de estado. Recarga para verla.", fresh);
  }
  return ok({ invoice: invoiceView(data as unknown as InvoiceRow) });
}

// -------------------------------------------------------------- mark_voided --

async function markVoided(admin: SupabaseClient, shopId: string, invoice: InvoiceRow): Promise<Response> {
  if (invoice.status === "voided") return ok({ invoice: invoiceView(invoice), alreadyVoided: true });
  if (invoice.status !== "authorized") {
    return conflict("Solo se puede marcar como anulada una factura autorizada.", invoice);
  }
  const { data, error } = await admin
    .from("invoices")
    .update({ status: "voided", voided_at: new Date().toISOString() })
    .eq("id", invoice.id)
    .eq("shop_id", shopId)
    .eq("status", "authorized")
    .select(INVOICE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`mark_voided falló: ${error.message}`);
  if (!data) {
    const fresh = await loadInvoice(admin, invoice.id, shopId);
    return conflict("La factura cambió de estado. Recarga para verla.", fresh);
  }
  return ok({ invoice: invoiceView(data as unknown as InvoiceRow) });
}

// ------------------------------------------------------------ refresh_files --

async function refreshFiles(admin: SupabaseClient, shopId: string, invoice: InvoiceRow): Promise<Response> {
  if (invoice.status !== "authorized" && invoice.status !== "voided") {
    return conflict("La factura todavía no está autorizada.", invoice);
  }
  if (invoice.xml_path && invoice.ride_path) return ok({ invoice: invoiceView(invoice) });
  const provider = providerFromEnv();
  if (!provider) return serverError(MISSING_CONFIG_MESSAGE);
  const apiKey = await getProviderKey(admin, shopId);
  if (!apiKey) return conflict("La configuración de facturación está incompleta.");
  const { row, errors } = await storeInvoiceFiles(admin, provider, apiKey, invoice);
  if (errors.length > 0 && (!row.xml_path || !row.ride_path)) {
    return json(502, {
      error: "No pudimos descargar los archivos de la factura del proveedor. Intenta de nuevo en unos minutos.",
      invoice: invoiceView(row),
    });
  }
  return ok({ invoice: invoiceView(row) });
}

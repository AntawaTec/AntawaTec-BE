// =============================================================================
// invoice-webhook/index.ts
// Webhook de AutorizadorEC: el proveedor avisa cuando un documento cambia de
// estado (document.authorized / document.rejected / document.failed).
//
// Auth: HMAC-SHA256 del body CRUDO con AUTORIZADOREC_WEBHOOK_SECRET (el mismo
// secreto se registra en cada empresa al crearla, ver billing-setup), comparado
// en tiempo constante. SIN el secreto configurado la función RECHAZA todo (500):
// un webhook sin firma que verificar sería una puerta para marcar facturas como
// autorizadas desde afuera.
//
// Idempotente y monótono (el proveedor reintenta y es "at-least-once"; además el
// mismo resultado puede llegar antes por la respuesta síncrona de invoice-emit o
// por invoice-reconcile). Cada transición es un UPDATE condicional al estado de
// origen permitido (_shared/billing/invoiceStore.ts):
//   - authorized: desde processing / failed / rejected / draft. Es la verdad del
//     SRI: aunque el dueño ya haya reabierto el borrador, si el SRI autorizó, la
//     factura ES esa (si no, emitiría un duplicado). Nunca pisa authorized/voided.
//   - rejected:   solo desde processing.
//   - failed:     solo desde processing y solo con document.failed (el proveedor
//     agotó sus reintentos).
//   - cualquier otro evento: informativo, no cambia el estado.
// Responde 200 también a eventos de documentos desconocidos (no son nuestros o
// son de una factura borrada): un 4xx haría que el proveedor reintente en vano.
//
// No baja el XML/RIDE: el proveedor exige respuesta en < 10 s. Los archivos los
// archiva invoice-emit (respuesta síncrona), invoice-reconcile o la acción
// `refresh_files`.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import { badRequest, json, methodNotAllowed, ok, serverError, unauthorized } from "../_shared/response.ts";
import { MISSING_CONFIG_MESSAGE, webhookSecretFromEnv } from "../_shared/billing/config.ts";
import { parseAutorizadorEcWebhook, userMessage, verifyAutorizadorEcSignature } from "../_shared/billing/autorizadorec.ts";
import { applyEmissionResult, INVOICE_COLUMNS, type InvoiceRow, type InvoiceStatus } from "../_shared/billing/invoiceStore.ts";
import type { EmissionResult, ProviderDocument } from "../_shared/billing/provider.ts";

const LABEL = "invoice-webhook";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return methodNotAllowed();

  const secret = webhookSecretFromEnv();
  if (!secret) {
    console.error(`${LABEL}: falta AUTORIZADOREC_WEBHOOK_SECRET; se rechaza el evento.`);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  const raw = await req.text();
  if (!(await verifyAutorizadorEcSignature(raw, req.headers, secret))) {
    return unauthorized("Firma inválida.");
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }
  const evt = parseAutorizadorEcWebhook(body);
  if (!evt) return ok({ ignored: true, reason: "evento sin documento" });

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError(MISSING_CONFIG_MESSAGE);
  }

  try {
    const invoice = await findInvoice(admin, evt.document);
    if (!invoice) {
      console.log(`${LABEL}: ${evt.event ?? "evento"} de un documento desconocido (${evt.document.accessKey ?? evt.document.providerId}); se ignora.`);
      return ok({ ignored: true, reason: "factura desconocida" });
    }
    if (!evt.outcome) return ok({ ok: true, status: invoice.status, changed: false });

    let from: InvoiceStatus[];
    let result: EmissionResult;
    switch (evt.outcome) {
      case "authorized": {
        from = ["processing", "failed", "rejected", "draft"];
        const notice = invoice.status === "draft"
          ? "El SRI autorizó el comprobante enviado antes de tu corrección; lo válido es lo que dice el RIDE."
          : null;
        result = { outcome: "authorized", document: evt.document, message: null, notice };
        break;
      }
      case "rejected":
        from = ["processing"];
        result = {
          outcome: "rejected",
          document: evt.document,
          message: userMessage(evt.document.errors) ?? "El SRI rechazó el comprobante.",
        };
        break;
      case "failed":
        if (!evt.finalFailure) return ok({ ok: true, status: invoice.status, changed: false });
        from = ["processing"];
        result = {
          outcome: "failed",
          document: evt.document,
          message: userMessage(evt.document.errors) ??
            "El proveedor no pudo completar la emisión después de varios reintentos. Vuelve a emitirla.",
        };
        break;
      default:
        return ok({ ok: true, status: invoice.status, changed: false });
    }

    const updated = await applyEmissionResult(admin, invoice.id, result, from);
    if (updated) {
      console.log(`${LABEL}: factura ${invoice.id} ${invoice.status} → ${updated.status} (${evt.event}).`);
    }
    return ok({ ok: true, status: updated?.status ?? invoice.status, changed: !!updated });
  } catch (e) {
    // 5xx → el proveedor reintenta (con backoff): es lo que queremos ante un
    // error transitorio nuestro.
    console.error(`${LABEL}: error procesando ${evt.event}:`, e instanceof Error ? e.message : e);
    return json(500, { error: "No se pudo procesar el evento." });
  }
});

/** idempotencyKey (= invoices.id) primero; si el evento no la trae, clave de acceso o id del proveedor. */
async function findInvoice(admin: SupabaseClient, doc: ProviderDocument): Promise<InvoiceRow | null> {
  const attempts: [string, string][] = [];
  if (doc.idempotencyKey && UUID_RE.test(doc.idempotencyKey)) attempts.push(["id", doc.idempotencyKey]);
  if (doc.accessKey) attempts.push(["access_key", doc.accessKey]);
  if (doc.providerId) attempts.push(["provider_document_id", doc.providerId]);
  for (const [col, val] of attempts) {
    const { data, error } = await admin.from("invoices").select(INVOICE_COLUMNS).eq(col, val).limit(2);
    if (error) throw new Error(`Búsqueda por ${col} falló: ${error.message}`);
    if (data && data.length === 1) return data[0] as unknown as InvoiceRow;
    if (data && data.length > 1) {
      // provider_document_id no es único entre proveedores/cuentas; ante la duda no se adivina.
      console.error(`${LABEL}: ${data.length} facturas con ${col}=${val}; se ignora el evento.`);
      return null;
    }
  }
  return null;
}

// =============================================================================
// _shared/billing/invoiceStore.ts
// Lecturas/escrituras de facturas con service_role, compartidas por
// invoice-emit, invoice-webhook e invoice-reconcile. Acá viven las reglas de
// persistencia que tienen que ser IDÉNTICAS en los tres caminos:
//
//   - Toda transición es un UPDATE CONDICIONAL al estado de origen permitido
//     (`.in("status", from)`): dos caminos que resuelven la misma factura a la vez
//     (respuesta síncrona + webhook, o reconcile + webhook) convergen; el segundo
//     no pisa al primero y un estado terminal nunca retrocede.
//   - Bajar el XML/RIDE es best-effort y NUNCA cambia `status`: si falla, la
//     factura queda `authorized` con las rutas en NULL (se completan con la acción
//     `refresh_files` de invoice-emit). Misma lección que los recibos de 0038.
// =============================================================================

import type { SupabaseClient } from "../supabaseAdmin.ts";
import type { BillingProvider, EmissionResult, ProviderDocument, ProviderFileKind } from "./provider.ts";
import {
  buildInvoicePayload,
  computeInvoiceTotals,
  diffStoredTotals,
  formatInvoiceNumber,
  type InvoicePayload,
  isBuyerIdType,
  isPaymentMethod,
  isTaxCode,
  type PaymentMethodCode,
  type Regimen,
  validateDraft,
} from "./sri.ts";

export const INVOICES_BUCKET = "invoices";

export const INVOICE_COLUMNS =
  "id, shop_id, work_order_id, quote_id, customer_id, status, environment, establecimiento, " +
  "punto_emision, issued_on, secuencial, access_key, authorization_number, authorized_at, " +
  "provider_document_id, provider_status, error, xml_path, ride_path, voided_at, buyer_id_type, " +
  "buyer_id_number, buyer_name, buyer_address, buyer_email, buyer_phone, subtotal, discount_total, " +
  "tax_total, total, payment_method, created_at, updated_at";

export const ITEM_COLUMNS =
  "id, position, code, description, quantity, unit_price, discount, tax_code, tax_rate, line_subtotal, line_tax, product_id";

export const SETTINGS_COLUMNS =
  "shop_id, ruc, razon_social, nombre_comercial, direccion_matriz, establecimiento, punto_emision, " +
  "obligado_contabilidad, regimen, contribuyente_especial, environment, provider, provider_company_id, " +
  "cert_expires_at, ready, created_at, updated_at";

/** Tope de líneas por factura (protege el payload y el `.range()` de abajo). */
export const MAX_ITEMS = 300;

export type InvoiceStatus = "draft" | "processing" | "authorized" | "rejected" | "failed" | "voided";

// deno-lint-ignore no-explicit-any
export type InvoiceRow = Record<string, any> & { id: string; shop_id: string; status: InvoiceStatus };
// deno-lint-ignore no-explicit-any
export type ItemRow = Record<string, any>;
// deno-lint-ignore no-explicit-any
export type SettingsRow = Record<string, any> & { shop_id: string };

/** Lo que devuelven las funciones al FE (sin columnas internas). */
export function invoiceView(row: InvoiceRow) {
  return {
    id: row.id,
    status: row.status,
    environment: row.environment ?? null,
    establecimiento: row.establecimiento ?? null,
    punto_emision: row.punto_emision ?? null,
    secuencial: row.secuencial ?? null,
    number: formatInvoiceNumber(row.establecimiento, row.punto_emision, row.secuencial),
    access_key: row.access_key ?? null,
    authorization_number: row.authorization_number ?? null,
    authorized_at: row.authorized_at ?? null,
    issued_on: row.issued_on ?? null,
    total: row.total,
    error: row.error ?? null,
    xml_path: row.xml_path ?? null,
    ride_path: row.ride_path ?? null,
    voided_at: row.voided_at ?? null,
    updated_at: row.updated_at,
  };
}

// ----------------------------------------------------------------- lecturas --

export async function loadInvoice(admin: SupabaseClient, id: string, shopId?: string): Promise<InvoiceRow | null> {
  let q = admin.from("invoices").select(INVOICE_COLUMNS).eq("id", id);
  if (shopId) q = q.eq("shop_id", shopId);
  const { data, error } = await q.maybeSingle();
  if (error) throw new Error(`Lectura de la factura falló: ${error.message}`);
  return (data as unknown as InvoiceRow) ?? null;
}

export async function loadItems(admin: SupabaseClient, invoiceId: string): Promise<ItemRow[]> {
  const { data, error } = await admin
    .from("invoice_items")
    .select(ITEM_COLUMNS)
    .eq("invoice_id", invoiceId)
    .order("position", { ascending: true })
    .order("id", { ascending: true })
    .range(0, MAX_ITEMS); // MAX_ITEMS + 1 filas como máximo: si llegan todas, sobra una
  if (error) throw new Error(`Lectura de los ítems falló: ${error.message}`);
  return (data ?? []) as ItemRow[];
}

export async function loadSettings(admin: SupabaseClient, shopId: string): Promise<SettingsRow | null> {
  const { data, error } = await admin
    .from("shop_billing_settings")
    .select(SETTINGS_COLUMNS)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`Lectura de la configuración de facturación falló: ${error.message}`);
  return (data as unknown as SettingsRow) ?? null;
}

/** API key del proveedor del taller, desde Vault (RPC solo-service_role de 0050). */
export async function getProviderKey(admin: SupabaseClient, shopId: string): Promise<string | null> {
  const { data, error } = await admin.rpc("get_billing_provider_key", { p_shop_id: shopId });
  if (error) throw new Error(`Lectura de la credencial del proveedor falló: ${error.message}`);
  return typeof data === "string" && data.length > 0 ? data : null;
}

export async function setProviderKey(admin: SupabaseClient, shopId: string, key: string): Promise<void> {
  const { error } = await admin.rpc("set_billing_provider_key", { p_shop_id: shopId, p_key: key });
  if (error) throw new Error(`No se pudo guardar la credencial del proveedor: ${error.message}`);
}

export async function shopBillingEnabled(admin: SupabaseClient, shopId: string): Promise<boolean> {
  const { data, error } = await admin.from("shops").select("billing_enabled").eq("id", shopId).maybeSingle();
  if (error) throw new Error(`Lectura del taller falló: ${error.message}`);
  return data?.billing_enabled === true;
}

/** ¿La firma está vigente ahora? */
export function certValid(settings: SettingsRow | null, nowMs: number): boolean {
  const exp = settings?.cert_expires_at ? Date.parse(settings.cert_expires_at) : NaN;
  return !Number.isNaN(exp) && exp > nowMs;
}

// -------------------------------------------------------------- preparación --

export type Preparation =
  | { ok: true; payload: InvoicePayload }
  | { ok: false; errors: string[] };

/**
 * Valida el borrador tal como está en la DB y arma el payload. Recalcula los
 * totales con _shared/billing/sri.ts y exige que coincidan AL CENTAVO con lo que
 * guardó el FE (líneas y totales). La serie y la fecha salen de la fila (las fija
 * invoice-emit al tomar el lock), con fallback a la configuración.
 */
export function prepareEmission(invoice: InvoiceRow, items: ItemRow[], settings: SettingsRow): Preparation {
  if (items.length === 0) return { ok: false, errors: ["La factura no tiene líneas."] };
  if (items.length > MAX_ITEMS) return { ok: false, errors: [`La factura no puede tener más de ${MAX_ITEMS} líneas.`] };
  if (!isBuyerIdType(invoice.buyer_id_type)) return { ok: false, errors: ["El tipo de identificación del comprador no es válido."] };
  for (const [i, it] of items.entries()) {
    if (!isTaxCode(it.tax_code)) return { ok: false, errors: [`Línea ${i + 1}: tarifa de IVA no válida.`] };
  }
  let totals;
  try {
    totals = computeInvoiceTotals(items.map((it) => ({
      quantity: it.quantity,
      unit_price: it.unit_price,
      discount: it.discount ?? 0,
      tax_code: it.tax_code,
    })));
  } catch (e) {
    return { ok: false, errors: [e instanceof Error ? e.message : String(e)] };
  }
  const errors = validateDraft(
    {
      buyer_id_type: invoice.buyer_id_type,
      buyer_id_number: invoice.buyer_id_number,
      buyer_name: invoice.buyer_name,
      buyer_address: invoice.buyer_address,
      buyer_email: invoice.buyer_email,
    },
    totals,
    invoice.payment_method,
  );
  if (errors.length > 0) return { ok: false, errors };

  const diff = diffStoredTotals(
    invoice as unknown as { subtotal: number; discount_total: number; tax_total: number; total: number },
    items.map((it) => ({
      quantity: it.quantity,
      unit_price: it.unit_price,
      discount: it.discount ?? 0,
      tax_code: it.tax_code,
      line_subtotal: it.line_subtotal,
      line_tax: it.line_tax,
    })),
    totals,
  );
  if (diff.length > 0) {
    return { ok: false, errors: ["Los totales guardados no coinciden con el cálculo del servidor.", ...diff] };
  }

  const issuedOn = invoice.issued_on as string | null;
  if (!issuedOn) return { ok: false, errors: ["La factura no tiene fecha de emisión."] };
  if (!isPaymentMethod(invoice.payment_method)) return { ok: false, errors: ["La forma de pago no es válida."] };

  const payload = buildInvoicePayload(
    {
      id: invoice.id,
      buyer_id_type: invoice.buyer_id_type,
      buyer_id_number: invoice.buyer_id_number,
      buyer_name: invoice.buyer_name,
      buyer_address: invoice.buyer_address,
      buyer_email: invoice.buyer_email,
      buyer_phone: invoice.buyer_phone,
      payment_method: invoice.payment_method as PaymentMethodCode,
      issued_on: issuedOn,
    },
    items.map((it) => ({
      code: it.code,
      description: it.description,
      quantity: it.quantity,
      unit_price: it.unit_price,
      discount: it.discount ?? 0,
      tax_code: it.tax_code,
    })),
    {
      establecimiento: invoice.establecimiento ?? settings.establecimiento,
      punto_emision: invoice.punto_emision ?? settings.punto_emision,
      obligado_contabilidad: settings.obligado_contabilidad === true,
      regimen: settings.regimen as Regimen,
      contribuyente_especial: settings.contribuyente_especial,
    },
  );
  return { ok: true, payload };
}

// ---------------------------------------------------------------- escritura --

/** Forma del `error` jsonb (lo lee el FE). */
export interface InvoiceErrorJson {
  source: "sri" | "provider" | "validation" | "notice";
  message: string;
  details?: unknown;
  http_status?: number | null;
  at: string;
}

function errorJson(
  source: InvoiceErrorJson["source"],
  message: string,
  extra: Partial<InvoiceErrorJson> = {},
): InvoiceErrorJson {
  return { source, message, at: new Date().toISOString(), ...extra };
}

function docFields(doc: ProviderDocument | null) {
  if (!doc) return {};
  const out: Record<string, unknown> = {};
  if (doc.providerId) out.provider_document_id = doc.providerId;
  if (doc.status) out.provider_status = doc.status;
  if (doc.accessKey) out.access_key = doc.accessKey;
  return out;
}

/**
 * Asienta un resultado del proveedor sobre la factura, SOLO si su estado actual
 * está en `from`. Devuelve la fila actualizada, o null si no se escribió nada
 * (otro camino ya la resolvió, o el resultado es 'processing' sin datos nuevos).
 */
export async function applyEmissionResult(
  admin: SupabaseClient,
  invoiceId: string,
  result: EmissionResult,
  from: InvoiceStatus[],
): Promise<InvoiceRow | null> {
  const doc = result.document;
  let patch: Record<string, unknown>;

  switch (result.outcome) {
    case "authorized":
      patch = {
        ...docFields(doc),
        status: "authorized",
        secuencial: doc?.secuencial ?? null,
        // En el esquema offline del SRI el número de autorización ES la clave de acceso.
        authorization_number: doc?.authorizationNumber ?? doc?.accessKey ?? null,
        authorized_at: doc?.authorizedAt ?? new Date().toISOString(),
        error: result.notice ? errorJson("notice", result.notice) : null,
      };
      if (doc?.establecimiento) patch.establecimiento = doc.establecimiento;
      if (doc?.puntoEmision) patch.punto_emision = doc.puntoEmision;
      if (!doc?.secuencial || !doc?.accessKey) {
        console.warn(`billing: factura ${invoiceId} autorizada sin secuencial/clave en la respuesta del proveedor.`);
      }
      break;
    case "rejected":
      patch = {
        ...docFields(doc),
        status: "rejected",
        error: errorJson("sri", result.message ?? "El SRI rechazó el comprobante.", { details: doc?.errors ?? [] }),
      };
      break;
    case "failed":
      patch = {
        ...docFields(doc),
        status: "failed",
        error: errorJson("provider", result.message ?? "No se pudo emitir la factura.", {
          http_status: result.httpStatus ?? null,
          details: doc?.errors?.length ? doc.errors : undefined,
        }),
      };
      break;
    case "processing": {
      const fields = docFields(doc);
      if (Object.keys(fields).length === 0) return null; // nada nuevo que guardar
      patch = fields;
      break;
    }
  }

  const { data, error } = await admin
    .from("invoices")
    .update(patch)
    .eq("id", invoiceId)
    .in("status", from)
    .select(INVOICE_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`No se pudo guardar el resultado de la emisión: ${error.message}`);
  return (data as unknown as InvoiceRow) ?? null;
}

const FILES: { kind: ProviderFileKind; name: string; contentType: string; column: "xml_path" | "ride_path" }[] = [
  { kind: "authorized_xml", name: "factura.xml", contentType: "application/xml", column: "xml_path" },
  { kind: "ride", name: "ride.pdf", contentType: "application/pdf", column: "ride_path" },
];

/**
 * Baja el XML autorizado y el RIDE del proveedor y los sube al bucket privado
 * `invoices`. Best-effort: lo que falle queda con su ruta en NULL y se reporta en
 * `errors`; jamás cambia `status`. Devuelve la fila (actualizada si subió algo).
 */
export async function storeInvoiceFiles(
  admin: SupabaseClient,
  provider: BillingProvider,
  apiKey: string,
  row: InvoiceRow,
): Promise<{ row: InvoiceRow; errors: string[] }> {
  const errors: string[] = [];
  if (!row.access_key) return { row, errors: ["La factura no tiene clave de acceso."] };
  const patch: Record<string, string> = {};
  for (const f of FILES) {
    if (row[f.column]) continue;
    const path = `${row.shop_id}/${row.id}/${f.name}`;
    try {
      const bytes = await provider.downloadFile(apiKey, row.access_key, f.kind);
      const { error } = await admin.storage
        .from(INVOICES_BUCKET)
        .upload(path, new Blob([new Uint8Array(bytes)], { type: f.contentType }), { contentType: f.contentType, upsert: true });
      if (error) throw new Error(error.message);
      patch[f.column] = path;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`billing: no se pudo archivar ${f.kind} de la factura ${row.id}: ${msg}`);
      errors.push(`${f.name}: ${msg}`);
    }
  }
  if (Object.keys(patch).length === 0) return { row, errors };
  const { data, error } = await admin
    .from("invoices")
    .update(patch)
    .eq("id", row.id)
    .in("status", ["authorized", "voided"])
    .select(INVOICE_COLUMNS)
    .maybeSingle();
  if (error) {
    console.error(`billing: no se pudieron guardar las rutas de la factura ${row.id}: ${error.message}`);
    errors.push(error.message);
    return { row, errors };
  }
  return { row: (data as unknown as InvoiceRow) ?? row, errors };
}

/**
 * Emisión completa de una factura que YA está en 'processing' (lock tomado por
 * invoice-emit, o fila recogida por invoice-reconcile): relee la fila e ítems,
 * valida, llama al proveedor, asienta y archiva. Si la validación falla NO llama
 * al proveedor y devuelve los errores (el caller decide: invoice-emit devuelve el
 * lock al estado anterior; invoice-reconcile la marca 'failed').
 */
export async function emitLocked(
  admin: SupabaseClient,
  provider: BillingProvider,
  apiKey: string,
  invoiceId: string,
  settings: SettingsRow,
): Promise<
  | { kind: "invalid"; errors: string[]; row: InvoiceRow | null }
  | { kind: "done"; result: EmissionResult; row: InvoiceRow | null }
> {
  const invoice = await loadInvoice(admin, invoiceId);
  if (!invoice || invoice.status !== "processing") return { kind: "invalid", errors: ["La factura ya no está en emisión."], row: invoice };
  const items = await loadItems(admin, invoiceId);
  const prep = prepareEmission(invoice, items, settings);
  if (!prep.ok) return { kind: "invalid", errors: prep.errors, row: invoice };

  const result = await provider.emitInvoice(apiKey, prep.payload);
  let row = await applyEmissionResult(admin, invoiceId, result, ["processing"]);
  if (!row) row = await loadInvoice(admin, invoiceId);
  if (row && row.status === "authorized") {
    row = (await storeInvoiceFiles(admin, provider, apiKey, row)).row;
  }
  return { kind: "done", result, row };
}

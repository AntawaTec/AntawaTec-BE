// =============================================================================
// _shared/billing/autorizadorec.ts
// Adaptador de AutorizadorEC (Veyzasoft), modo MULTIEMPRESA.
//
// Basado en su OpenAPI (https://api.autorizadorec.com/api/docs-json, "FacturaEC
// API" v1.0) y en la guía del panel (https://panel.autorizadorec.com/docs),
// leídos el 2026-11-09. El OpenAPI no documenta los cuerpos de respuesta: las
// formas de respuesta salen de los ejemplos de la guía. Todo lo que la
// documentación no deja claro está marcado `// VERIFICAR EN SANDBOX:`.
//
// Dos credenciales:
//   - X-Account-Key (ak_…, secret global AUTORIZADOREC_ACCOUNT_KEY): administra
//     las empresas de la cuenta (/client/companies…).
//   - X-API-Key (sk_…, una por empresa = por taller, en Vault): emite y consulta
//     documentos (/documents…).
//
// Decisiones que importan:
//   - idempotencyKey = invoices.id. Antes de emitir se CONSULTA el documento por
//     esa key (GET /documents/by-idempotency-key/{key}): si ya existe, no se crea
//     otro. Un REJECTED/FAILED existente se CORRIGE con PUT
//     /documents/{claveAcceso}/emit (la guía: "Corrija los datos y reenvíe con
//     PUT… No lo emita como documento nuevo con otro número"); el proveedor
//     consulta al SRI antes de aplicar la corrección y, si ya estaba autorizado,
//     lo deja AUTHORIZED. Así "Corregir y reintentar" nunca duplica el comprobante.
//   - FAILED del proveedor ≠ nuestro 'failed': para ellos es "el SRI no respondió,
//     el comprobante PUDO haber llegado, lo reintento solo". Para nosotros es
//     'processing' hasta que el webhook document.failed (reintentos agotados) o
//     invoice-reconcile digan lo contrario.
//   - Nunca se loguea ni se devuelve el body ENVIADO (el .p12 y su clave viajan
//     por uploadCertificate).
// =============================================================================

import type { InvoicePayload } from "./sri.ts";
import { timingSafeEqual } from "../deliveryReceipts.ts";
import {
  type BillingEnvironment,
  type BillingProvider,
  type CertificateInfo,
  type CompanyInput,
  type CompanyRef,
  type EmissionResult,
  type FetchLike,
  ProviderError,
  type ProviderDocument,
  type ProviderFileKind,
  type ProviderMessage,
  type WebhookEvent,
} from "./provider.ts";

export interface AutorizadorEcConfig {
  /** Base con versión, p. ej. https://api.autorizadorec.com/api/v1 (sin barra final). */
  baseUrl: string;
  /** ak_… de la cuenta multiempresa. */
  accountKey: string;
  /** planId con el que se crean las empresas (lo exige POST /client/companies). */
  planId?: number | null;
  fetch?: FetchLike;
  /** Timeout de la emisión síncrona (la guía: típico 5–15 s, techo del servidor 60 s). */
  emitTimeoutMs?: number;
  /** Timeout del resto de llamadas. */
  timeoutMs?: number;
}

const EMIT_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

type Json = Record<string, unknown>;

interface RequestOptions {
  method: string;
  path: string;
  auth: { header: "X-Account-Key" | "X-API-Key"; value: string };
  json?: unknown;
  form?: FormData;
  timeoutMs?: number;
  binary?: boolean;
}

export class AutorizadorEcProvider implements BillingProvider {
  readonly name = "autorizadorec";
  private readonly baseUrl: string;
  private readonly fetchFn: FetchLike;

  constructor(private readonly cfg: AutorizadorEcConfig) {
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.fetchFn = cfg.fetch ?? fetch;
  }

  // ---------------------------------------------------------------- HTTP ---

  private async request(opts: RequestOptions): Promise<{ status: number; body: unknown; bytes?: Uint8Array }> {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { [opts.auth.header]: opts.auth.value, accept: "application/json" };
    let body: BodyInit | undefined;
    if (opts.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts.form) {
      body = opts.form; // fetch pone el boundary del multipart
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}${opts.path}`, {
        method: opts.method,
        headers,
        body,
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (controller.signal.aborted || (e instanceof DOMException && e.name === "AbortError")) {
        throw new ProviderError("timeout", `AutorizadorEC no respondió en ${timeoutMs} ms (${opts.method} ${opts.path})`);
      }
      throw new ProviderError("network", `Error de red con AutorizadorEC (${opts.method} ${opts.path}): ${String(e)}`);
    }
    try {
      if (opts.binary && res.ok) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return { status: res.status, body: null, bytes };
      }
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { message: text.slice(0, 500) };
        }
      }
      if (!res.ok) {
        const msg = providerMessageOf(parsed);
        throw new ProviderError(
          "http",
          `AutorizadorEC respondió ${res.status} (${opts.method} ${opts.path})${msg ? `: ${msg}` : ""}`,
          res.status,
          msg,
        );
      }
      return { status: res.status, body: parsed };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (controller.signal.aborted) {
        throw new ProviderError("timeout", `AutorizadorEC no respondió en ${timeoutMs} ms (${opts.method} ${opts.path})`);
      }
      throw new ProviderError("network", `Respuesta ilegible de AutorizadorEC (${opts.method} ${opts.path}): ${String(e)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private account() {
    return { header: "X-Account-Key" as const, value: this.cfg.accountKey };
  }

  private company(apiKey: string) {
    return { header: "X-API-Key" as const, value: apiKey };
  }

  // ------------------------------------------------------------ Empresas ---

  async findCompanyByRuc(ruc: string): Promise<CompanyRef | null> {
    // GET /client/companies lista las empresas de la cuenta CON su apiKey (guía).
    // VERIFICAR EN SANDBOX: si el listado pagina o enmascara la apiKey. Si la
    // enmascara, este camino de recuperación no sirve y hay que regenerar la key
    // (POST /client/companies/{id}/regenerate-key).
    const { body } = await this.request({ method: "GET", path: "/client/companies", auth: this.account() });
    const list = Array.isArray(body) ? body : Array.isArray((body as Json)?.data) ? (body as Json).data as unknown[] : [];
    for (const c of list) {
      const row = c as Json;
      if (String(row?.ruc ?? "") === ruc && row?.id != null) {
        const apiKey = typeof row.apiKey === "string" ? row.apiKey : null;
        if (!apiKey || apiKey.includes("…") || apiKey.includes("...") || apiKey.includes("•")) {
          throw new ProviderError(
            "http",
            "La empresa ya existe en AutorizadorEC pero su API key no está disponible.",
            409,
            "la empresa ya existe en el proveedor pero su credencial no está disponible; avisa a soporte de Antawa",
          );
        }
        return { companyId: String(row.id), apiKey };
      }
    }
    return null;
  }

  async createCompany(input: CompanyInput): Promise<CompanyRef> {
    if (!this.cfg.planId) throw new ProviderError("http", "Falta el planId de AutorizadorEC (AUTORIZADOREC_PLAN_ID).", null);
    const { body } = await this.request({
      method: "POST",
      path: "/client/companies",
      auth: this.account(),
      json: {
        planId: this.cfg.planId,
        name: input.razonSocial,
        tradeName: input.nombreComercial || undefined,
        ruc: input.ruc,
        address: input.direccionMatriz,
        email: input.email || undefined,
        phone: input.phone || undefined,
        env: input.environment,
        establishment: input.establecimiento,
        webhookUrl: input.webhookUrl,
        webhookSecret: input.webhookSecret,
        accessKeyMode: "platform",
        sequentialMode: "platform",
        // El correo con el RIDE al cliente final lo manda el proveedor (plan, Fase 3).
        notifyClient: true,
        notifyCompany: true,
        notificationEmail: input.email || undefined,
        timezone: "America/Guayaquil",
      },
    });
    const row = body as Json;
    const apiKey = typeof row?.apiKey === "string" ? row.apiKey : null;
    if (row?.id == null || !apiKey) {
      throw new ProviderError("http", "AutorizadorEC creó la empresa pero no devolvió id/apiKey.", null);
    }
    return { companyId: String(row.id), apiKey };
  }

  async updateCompany(companyId: string, input: Omit<CompanyInput, "ruc" | "environment">): Promise<void> {
    await this.request({
      method: "PATCH",
      path: `/client/companies/${encodeURIComponent(companyId)}`,
      auth: this.account(),
      json: {
        name: input.razonSocial,
        tradeName: input.nombreComercial || undefined,
        address: input.direccionMatriz,
        email: input.email || undefined,
        phone: input.phone || undefined,
        establishment: input.establecimiento,
        webhookUrl: input.webhookUrl,
        webhookSecret: input.webhookSecret,
        notificationEmail: input.email || undefined,
      },
    });
  }

  async changeCompanyRuc(companyId: string, ruc: string): Promise<void> {
    // Solo permitido mientras la empresa no tenga comprobantes autorizados en
    // producción (OpenAPI). Si no, el proveedor responde 4xx y billing-setup lo muestra.
    await this.request({
      method: "PATCH",
      path: `/client/companies/${encodeURIComponent(companyId)}/ruc`,
      auth: this.account(),
      json: { ruc },
    });
  }

  async ensureSeries(
    companyId: string,
    series: { establecimiento: string; puntoEmision: string; address: string; name: string },
  ): Promise<void> {
    const base = `/client/companies/${encodeURIComponent(companyId)}`;
    const { body } = await this.request({ method: "GET", path: `${base}/establishments`, auth: this.account() });
    const list = (Array.isArray(body) ? body : []) as Json[];
    let est = list.find((e) => String(e?.code ?? "") === series.establecimiento);
    if (!est) {
      // La guía: crear un establecimiento crea solo su punto de emisión 001.
      const created = await this.request({
        method: "POST",
        path: `${base}/establishments`,
        auth: this.account(),
        json: { code: series.establecimiento, name: series.name.slice(0, 100), address: series.address },
      });
      est = (created.body ?? {}) as Json;
    }
    const points = (Array.isArray(est?.emissionPoints) ? est.emissionPoints : []) as Json[];
    // VERIFICAR EN SANDBOX: que el establecimiento principal creado junto con la
    // empresa traiga su punto 001 en `emissionPoints` (el ejemplo de la guía sí).
    if (points.some((p) => String(p?.code ?? "") === series.puntoEmision)) return;
    try {
      await this.request({
        method: "POST",
        path: `${base}/emission-points`,
        auth: this.account(),
        json: {
          code: series.puntoEmision,
          establecimiento: series.establecimiento,
          description: `Punto ${series.puntoEmision}`,
        },
      });
    } catch (e) {
      // 409 = ya existía (carrera o listado incompleto): es el estado deseado.
      if (e instanceof ProviderError && e.status === 409) return;
      throw e;
    }
  }

  async setEnvironment(companyId: string, env: BillingEnvironment): Promise<void> {
    await this.request({
      method: "PATCH",
      path: `/client/companies/${encodeURIComponent(companyId)}`,
      auth: this.account(),
      json: { env },
    });
  }

  async uploadCertificate(companyId: string, p12: Uint8Array, password: string): Promise<CertificateInfo> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(p12)], { type: "application/x-pkcs12" }), "firma.p12");
    form.append("password", password);
    const { body } = await this.request({
      method: "POST",
      path: `/client/companies/${encodeURIComponent(companyId)}/certificates`,
      auth: this.account(),
      form,
    });
    const row = (body ?? {}) as Json;
    const cert = (row.certificate ?? {}) as Json;
    const validation = (row.validation ?? {}) as Json;
    const rawExp = (validation.validTo ?? cert.expiresAt ?? null) as string | null;
    return {
      expiresAt: parseIsoish(rawExp),
      subject: (cert.subjectCn ?? validation.subjectCn ?? null) as string | null,
    };
  }

  // ---------------------------------------------------------- Documentos ---

  async findDocument(apiKey: string, idempotencyKey: string): Promise<EmissionResult | null> {
    try {
      const { body } = await this.request({
        method: "GET",
        path: `/documents/by-idempotency-key/${encodeURIComponent(idempotencyKey)}`,
        auth: this.company(apiKey),
      });
      return resultFromDocument(normalizeDocument(body));
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) return null;
      throw e;
    }
  }

  async emitInvoice(apiKey: string, payload: InvoicePayload): Promise<EmissionResult> {
    // 1) ¿Ya existe un documento con esta idempotencyKey?
    let existing: EmissionResult | null;
    try {
      existing = await this.findDocument(apiKey, payload.idempotencyKey);
    } catch (e) {
      // Sin saber si existe, no se crea nada: queda 'processing' y lo resuelve
      // invoice-reconcile (que repite esta misma consulta). 401/403 sí son
      // definitivos (credencial o cuenta): 'failed'.
      return fromError(e, "lookup");
    }

    if (existing) {
      const st = existing.document?.status;
      if (st === "AUTHORIZED") {
        return { ...existing, notice: "El SRI ya había autorizado este comprobante; se registró ese resultado." };
      }
      if ((st === "REJECTED" || st === "FAILED") && existing.document?.accessKey) {
        // 2a) Corregir y reprocesar (síncrono). La guía: un PUT sobre un documento
        // que ya pasó por el SRI genera una clave de acceso NUEVA y conserva el
        // secuencial; se guarda la que devuelve la respuesta.
        return await this.send(
          "PUT",
          `/documents/${encodeURIComponent(existing.document.accessKey)}/emit`,
          apiKey,
          payload,
        );
      }
      // CREATED / PROCESSING / RECEIVED: el proveedor lo está procesando.
      return existing;
    }

    // 2b) Primera emisión (síncrona).
    // VERIFICAR EN SANDBOX: qué devuelve /documents/emit si llega una
    // idempotencyKey ya usada (la guía de POST /documents dice "se retorna el
    // documento existente"); igual el GET de arriba evita depender de eso.
    return await this.send("POST", "/documents/emit", apiKey, payload);
  }

  private async send(method: "POST" | "PUT", path: string, apiKey: string, payload: InvoicePayload): Promise<EmissionResult> {
    try {
      const { body, status } = await this.request({
        method,
        path,
        auth: this.company(apiKey),
        json: payload,
        timeoutMs: this.cfg.emitTimeoutMs ?? EMIT_TIMEOUT_MS,
      });
      const doc = normalizeDocument(body);
      const result = resultFromDocument(doc);
      const aviso = (body as Json)?.aviso;
      return {
        ...result,
        httpStatus: status,
        notice: typeof aviso === "string" ? aviso : result.notice ?? null,
      };
    } catch (e) {
      return fromError(e, method === "PUT" ? "correct" : "create");
    }
  }

  async downloadFile(apiKey: string, accessKey: string, kind: ProviderFileKind): Promise<Uint8Array> {
    const { bytes } = await this.request({
      method: "GET",
      path: `/documents/${encodeURIComponent(accessKey)}/files/${kind}`,
      auth: this.company(apiKey),
      binary: true,
    });
    if (!bytes || bytes.length === 0) throw new ProviderError("http", `Archivo ${kind} vacío`, null);
    return bytes;
  }

  // ------------------------------------------------------------- Webhook ---

  async verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
    return await verifyAutorizadorEcSignature(rawBody, headers, secret);
  }

  parseWebhook(body: unknown): WebhookEvent | null {
    return parseAutorizadorEcWebhook(body);
  }
}

// ====================================================================== puros ==

/**
 * Firma del webhook: HMAC-SHA256 del body CRUDO con el webhookSecret, en hex.
 * La documentación del proveedor es inconsistente sobre la cabecera:
 *   - PATCH /company/settings y el ejemplo de verificación: `X-AutorizadorEC-Signature: sha256=<hex>`
 *   - sección "Webhooks" de la guía: `X-Webhook-Signature: <hex>`
 * Se aceptan las dos, con o sin prefijo `sha256=`.
 * VERIFICAR EN SANDBOX: cuál cabecera manda de verdad y si lleva prefijo.
 */
export async function verifyAutorizadorEcSignature(rawBody: string, headers: Headers, secret: string): Promise<boolean> {
  if (!secret) return false;
  const candidates = [headers.get("x-autorizadorec-signature"), headers.get("x-webhook-signature")]
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim().replace(/^sha256=/i, "").toLowerCase());
  if (candidates.length === 0) return false;
  const expected = await hmacSha256Hex(secret, rawBody);
  let ok = false;
  for (const c of candidates) ok = timingSafeEqual(c, expected) || ok;
  return ok;
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** "sha256=<hex>" listo para la cabecera (tests y smoke manual). */
export async function signAutorizadorEcBody(secret: string, rawBody: string): Promise<string> {
  return `sha256=${await hmacSha256Hex(secret, rawBody)}`;
}

/** Evento del webhook → vocabulario común. */
export function parseAutorizadorEcWebhook(body: unknown): WebhookEvent | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Json;
  const data = b.data;
  if (!data || typeof data !== "object") return null;
  const event = typeof b.event === "string" ? b.event : null;
  const doc = normalizeDocument(data);
  if (!doc.idempotencyKey && !doc.accessKey && !doc.providerId) return null;

  let outcome: EmissionResult["outcome"] | null = null;
  let finalFailure = false;
  if (event === "document.authorized" || doc.status === "AUTHORIZED") outcome = "authorized";
  else if (event === "document.rejected" || doc.status === "REJECTED") outcome = "rejected";
  else if (event === "document.failed") {
    // "Cuando el procesamiento falla después de agotar reintentos" (guía).
    outcome = "failed";
    finalFailure = true;
  }
  return { event, outcome, finalFailure, document: doc };
}

/**
 * Documento del proveedor (respuesta de emit, GET por key, GET por clave o
 * `data` del webhook) → ProviderDocument. Tolera las dos formas de errores que
 * documenta la guía: `errors[]` {code, message, detail, category} en el GET y
 * `errores[]` {codigo, mensaje, detalle, categoria} en el webhook y en
 * `procesamiento`.
 */
export function normalizeDocument(raw: unknown): ProviderDocument {
  const d = (raw && typeof raw === "object" ? raw : {}) as Json;
  const proc = (d.procesamiento && typeof d.procesamiento === "object" ? d.procesamiento : {}) as Json;
  const num = parseSeriesNumber(d.secuencial, d.establecimiento, d.puntoEmision);
  const errors = [
    ...normalizeMessages(d.errors),
    ...normalizeMessages(d.errores),
    ...normalizeMessages(proc.errores),
  ];
  const status = typeof d.estado === "string" ? d.estado.toUpperCase() : null;
  const accessKey = typeof d.claveAcceso === "string" && /^[0-9]{49}$/.test(d.claveAcceso) ? d.claveAcceso : null;
  const authNumber = firstString(d.numeroAutorizacion, proc.numeroAutorizacion);
  const authDate = firstString(d.fechaAutorizacion, proc.fechaAutorizacion);
  return {
    providerId: d.id != null ? String(d.id) : null,
    status,
    accessKey,
    establecimiento: num.establecimiento,
    puntoEmision: num.puntoEmision,
    secuencial: num.secuencial,
    authorizationNumber: authNumber,
    authorizedAt: parseIsoish(authDate),
    idempotencyKey: typeof d.idempotencyKey === "string" ? d.idempotencyKey : null,
    errors: dedupeMessages(errors),
  };
}

function resultFromDocument(doc: ProviderDocument): EmissionResult {
  switch (doc.status) {
    case "AUTHORIZED":
      return { outcome: "authorized", document: doc, message: null };
    case "REJECTED":
      return { outcome: "rejected", document: doc, message: userMessage(doc.errors) ?? "El SRI rechazó el comprobante." };
    default:
      // CREATED / PROCESSING / RECEIVED / FAILED (el proveedor reintenta solo).
      return { outcome: "processing", document: doc, message: null };
  }
}

/** Error de transporte/HTTP → resultado. Solo los 4xx que garantizan "no hay documento" son 'failed'. */
function fromError(e: unknown, phase: "lookup" | "create" | "correct"): EmissionResult {
  if (!(e instanceof ProviderError)) {
    return { outcome: "processing", document: null, message: "Sin respuesta del proveedor; se reintentará." };
  }
  const status = e.status ?? null;
  if (e.kind !== "http" || status === null || status >= 500 || status === 408 || status === 429) {
    return { outcome: "processing", document: null, message: "Sin respuesta definitiva del proveedor; se reintentará.", httpStatus: status };
  }
  if (status === 401) {
    return { outcome: "failed", document: null, message: "La credencial del proveedor de facturación no es válida o la empresa está suspendida.", httpStatus: status };
  }
  if (status === 403) {
    return { outcome: "failed", document: null, message: e.providerMessage || "El proveedor de facturación no permite emitir (límite del plan o cuenta desactivada).", httpStatus: status };
  }
  if (phase === "correct" && (status === 409 || status === 404)) {
    // 409 en PUT = "documento no corregible" (ya autorizado o en proceso). No se
    // sabe cuál: lo resuelve invoice-reconcile con un GET.
    return { outcome: "processing", document: null, message: null, httpStatus: status };
  }
  if (phase === "lookup") {
    // Un 4xx raro en la consulta (no 404, que ya es null): no emitir a ciegas.
    return { outcome: "processing", document: null, message: null, httpStatus: status };
  }
  if (status === 409) {
    return {
      outcome: "failed",
      document: null,
      message: "Ya existe un comprobante idéntico (mismo comprador, fecha, monto y detalle). Revisa si esta venta ya se facturó.",
      httpStatus: status,
    };
  }
  return {
    outcome: "failed",
    document: null,
    message: e.providerMessage ? `El proveedor rechazó los datos: ${e.providerMessage}` : "El proveedor rechazó los datos de la factura.",
    httpStatus: status,
  };
}

function normalizeMessages(raw: unknown): ProviderMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: ProviderMessage[] = [];
  for (const r of raw) {
    if (typeof r === "string") {
      out.push({ message: r });
      continue;
    }
    if (!r || typeof r !== "object") continue;
    const m = r as Json;
    const message = firstString(m.mensaje, m.message) ?? firstString(m.detalle, m.detail);
    if (!message) continue;
    out.push({
      code: firstString(m.codigo, m.code),
      message,
      detail: firstString(m.detalle, m.detail),
      category: firstString(m.categoria, m.category),
    });
  }
  return out;
}

function dedupeMessages(list: ProviderMessage[]): ProviderMessage[] {
  const seen = new Set<string>();
  return list.filter((m) => {
    const k = `${m.code ?? ""}|${m.message}|${m.detail ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Texto para el usuario: el `detalle` trae la explicación (guía), si no el mensaje. */
export function userMessage(errors: ProviderMessage[]): string | null {
  if (errors.length === 0) return null;
  return errors
    .map((e) => [e.code ? `[${e.code}]` : null, e.detail || e.message].filter(Boolean).join(" "))
    .join(" · ")
    .slice(0, 1000);
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v.trim();
  return null;
}

/** message del body de error: string o array (validación de NestJS). */
function providerMessageOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const m = (body as Json).message;
  if (typeof m === "string") return m.slice(0, 500);
  if (Array.isArray(m)) return m.filter((x) => typeof x === "string").join("; ").slice(0, 500);
  return null;
}

/**
 * "001-001-000000042" (lo que devuelve el proveedor en `secuencial`) → partes.
 * Si viene solo el secuencial, el establecimiento/punto salen de los campos aparte.
 */
export function parseSeriesNumber(
  rawSec: unknown,
  rawEst: unknown,
  rawPto: unknown,
): { establecimiento: string | null; puntoEmision: string | null; secuencial: string | null } {
  const est = typeof rawEst === "string" && /^[0-9]{3}$/.test(rawEst) ? rawEst : null;
  const pto = typeof rawPto === "string" && /^[0-9]{3}$/.test(rawPto) ? rawPto : null;
  if (typeof rawSec === "string") {
    const full = /^([0-9]{3})-([0-9]{3})-([0-9]{1,9})$/.exec(rawSec.trim());
    if (full) return { establecimiento: full[1], puntoEmision: full[2], secuencial: full[3].padStart(9, "0") };
    if (/^[0-9]{1,9}$/.test(rawSec.trim())) {
      return { establecimiento: est, puntoEmision: pto, secuencial: rawSec.trim().padStart(9, "0") };
    }
  }
  if (typeof rawSec === "number" && Number.isInteger(rawSec) && rawSec > 0) {
    return { establecimiento: est, puntoEmision: pto, secuencial: String(rawSec).padStart(9, "0") };
  }
  return { establecimiento: est, puntoEmision: pto, secuencial: null };
}

/**
 * Fecha del proveedor → ISO. Acepta ISO ("2026-03-06T14:32:15.000Z"),
 * "2026-05-15" y el formato local que aparece en un ejemplo de la guía
 * ("06/03/2026, 14:35:20", que se interpreta en hora de Ecuador).
 * VERIFICAR EN SANDBOX: en qué formato llega `fechaAutorizacion` en facturas.
 */
export function parseIsoish(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const s = raw.trim();
  const local = /^(\d{2})\/(\d{2})\/(\d{4})(?:,?\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(s);
  if (local) {
    const [, dd, mm, yyyy, hh = "00", mi = "00", ss = "00"] = local;
    const t = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}-05:00`);
    return Number.isNaN(t) ? null : new Date(t).toISOString();
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

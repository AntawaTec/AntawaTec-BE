// =============================================================================
// _shared/billing/provider.ts
// Interfaz del proveedor de facturación electrónica. Hoy la implementa
// AutorizadorEC (`autorizadorec.ts`); si hubiera que migrar (Factuplan es el
// plan B), se escribe otro adaptador con esta misma forma y las Edge Functions
// no se enteran — mismo principio que los proveedores de pago (CLAUDE.md §7).
//
// El `fetch` es INYECTABLE: los tests usan uno falso y nunca tocan la API real.
// =============================================================================

import type { InvoicePayload } from "./sri.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Ambiente del SRI en el que emite una empresa. */
export type BillingEnvironment = "test" | "production";

/**
 * Resultado de una emisión, ya traducido a NUESTRO vocabulario:
 *   - authorized: el SRI la autorizó.
 *   - rejected:   el SRI la rechazó por contenido (mensajes en `errors`). Se corrige
 *                 y se reenvía (el adaptador sabe cómo: ver emitInvoice).
 *   - failed:     el proveedor NO tiene un documento vivo para esta factura
 *                 (validación 4xx, credenciales, límite del plan). Se puede reintentar.
 *   - processing: sin respuesta definitiva (timeout, 5xx, el SRI no contestó y el
 *                 proveedor lo reintenta solo). NUNCA reemitir con otro número:
 *                 lo resuelve el webhook o invoice-reconcile.
 */
export type EmissionOutcome = "authorized" | "rejected" | "failed" | "processing";

export interface ProviderMessage {
  code?: string | null;
  message: string;
  detail?: string | null;
  category?: string | null;
}

/** El documento tal como lo reporta el proveedor (campos que guardamos). */
export interface ProviderDocument {
  providerId: string | null;          // id interno del proveedor
  status: string | null;              // estado crudo (AUTHORIZED, REJECTED, FAILED, RECEIVED…)
  accessKey: string | null;           // clave de acceso (49 dígitos)
  establecimiento: string | null;
  puntoEmision: string | null;
  secuencial: string | null;          // 9 dígitos
  authorizationNumber: string | null;
  authorizedAt: string | null;        // ISO
  idempotencyKey: string | null;
  errors: ProviderMessage[];
}

export interface EmissionResult {
  outcome: EmissionOutcome;
  document: ProviderDocument | null;
  /** Mensaje para el usuario (rechazo, falla o aviso). */
  message: string | null;
  /** Aviso no bloqueante (p. ej. "el SRI ya la había autorizado"). */
  notice?: string | null;
  httpStatus?: number | null;
}

export interface CompanyInput {
  ruc: string;
  razonSocial: string;
  nombreComercial?: string | null;
  direccionMatriz: string;
  email?: string | null;
  phone?: string | null;
  environment: BillingEnvironment;
  establecimiento: string;
  webhookUrl: string;
  webhookSecret: string;
}

export interface CompanyRef {
  companyId: string;
  apiKey: string;
}

export interface CertificateInfo {
  expiresAt: string | null; // ISO
  subject: string | null;
}

export type ProviderFileKind = "authorized_xml" | "ride";

export interface BillingProvider {
  readonly name: string;

  /** Empresa existente de la cuenta con ese RUC (con su API key), o null. */
  findCompanyByRuc(ruc: string): Promise<CompanyRef | null>;
  createCompany(input: CompanyInput): Promise<CompanyRef>;
  updateCompany(companyId: string, input: Omit<CompanyInput, "ruc" | "environment">): Promise<void>;
  changeCompanyRuc(companyId: string, ruc: string): Promise<void>;
  /** Garantiza que exista el establecimiento y su punto de emisión. */
  ensureSeries(
    companyId: string,
    series: { establecimiento: string; puntoEmision: string; address: string; name: string },
  ): Promise<void>;
  setEnvironment(companyId: string, env: BillingEnvironment): Promise<void>;
  /** Reenvía el .p12 al proveedor. El adaptador NO lo persiste ni lo loguea. */
  uploadCertificate(companyId: string, p12: Uint8Array, password: string): Promise<CertificateInfo>;

  /** Emite (o corrige y reenvía) la factura. Nunca lanza por la red: devuelve 'processing'. */
  emitInvoice(apiKey: string, payload: InvoicePayload): Promise<EmissionResult>;
  /** Estado del documento de esa idempotencyKey; null si el proveedor no lo tiene (404). */
  findDocument(apiKey: string, idempotencyKey: string): Promise<EmissionResult | null>;
  downloadFile(apiKey: string, accessKey: string, kind: ProviderFileKind): Promise<Uint8Array>;

  /** Firma del webhook sobre el body CRUDO. */
  verifyWebhook(rawBody: string, headers: Headers, secret: string): Promise<boolean>;
  /** Evento del webhook normalizado, o null si el body no se entiende. */
  parseWebhook(body: unknown): WebhookEvent | null;
}

export interface WebhookEvent {
  event: string | null;     // document.authorized | document.rejected | document.failed | …
  outcome: EmissionOutcome | null; // null = evento informativo (recibido, en proceso)
  /** true solo para document.failed: el proveedor agotó sus reintentos. */
  finalFailure: boolean;
  document: ProviderDocument;
}

/** Error de transporte/HTTP del proveedor (nunca incluye el body que se envió). */
export class ProviderError extends Error {
  constructor(
    readonly kind: "network" | "timeout" | "http",
    message: string,
    readonly status: number | null = null,
    readonly providerMessage: string | null = null,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

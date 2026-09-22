// =============================================================================
// _shared/payphone.ts
// Cliente HTTP mínimo del Botón de Pago de Payphone (modo REDIRECCIÓN) y única
// fuente del precio en el backend. Lo usan payphone-prepare y payphone-confirm.
//
// Flujo del proveedor (docs.payphone.app):
//   1. Prepare  -> devuelve `payWithCard`, una URL a la que redirigimos al
//      usuario. El link vive 10 minutos.
//   2. Payphone cobra y devuelve al usuario a
//      `responseUrl?id=<int>&clientTransactionId=<uuid>`.
//   3. Confirm  -> OBLIGATORIO dentro de los 5 minutos siguientes; si no,
//      Payphone REVERSA el cobro. Es la ÚNICA fuente de verdad del pago (el
//      webhook externo de Payphone no viene firmado, así que no sirve como tal).
//      NO es idempotente: solo una invocación debe llamarlo (de ahí el lock
//      optimista de card_payment_intents en 0037).
//
// Montos: SIEMPRE centavos enteros, y debe cumplirse
//   amount = amountWithoutTax + amountWithTax + tax + service + tip
// $25.00 IVA incluido (15 %) => 2174 + 326 = 2500.
//
// Secretos vía Deno.env (CLAUDE.md); el token NUNCA sale de la función.
// =============================================================================

const PAYPHONE_API_BASE = "https://pay.payphonetodoesposible.com/api/button";

/** Corte de las llamadas al proveedor: mejor un 500 propio que colgar al usuario. */
const REQUEST_TIMEOUT_MS = 15_000;

// --- Precio (fuente única en el BE) ------------------------------------------

/** Precio de lista en dólares. Es lo que se guarda en card_payment_intents.amount. */
export const PRICE_USD = 25;
/** Total cobrado, en centavos. Lo que Payphone captura. */
export const PRICE_CENTS = 2500;
/** Base imponible en centavos (IVA 15 % incluido en el precio de lista). */
export const PRICE_WITH_TAX_CENTS = 2174;
/** IVA en centavos. PRICE_WITH_TAX_CENTS + TAX_CENTS === PRICE_CENTS. */
export const TAX_CENTS = 326;
export const CURRENCY = "USD";

// --- Entorno -----------------------------------------------------------------

export interface PayphoneEnv {
  token: string;
  storeId: string;
  responseUrl: string;
  cancellationUrl: string;
}

/**
 * Lee la configuración de Payphone del entorno. Lanza si falta algo, misma
 * convención que `_shared/supabaseAdmin.ts`: el caller lo atrapa y responde
 * 500 "Configuración del servidor incompleta." sin escribir nada.
 */
export function payphoneEnv(): PayphoneEnv {
  const token = Deno.env.get("PAYPHONE_TOKEN");
  const storeId = Deno.env.get("PAYPHONE_STORE_ID");
  const responseUrl = Deno.env.get("PAYPHONE_RESPONSE_URL");
  const cancellationUrl = Deno.env.get("PAYPHONE_CANCELLATION_URL");
  const missing = [
    ["PAYPHONE_TOKEN", token],
    ["PAYPHONE_STORE_ID", storeId],
    ["PAYPHONE_RESPONSE_URL", responseUrl],
    ["PAYPHONE_CANCELLATION_URL", cancellationUrl],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de Payphone en el entorno de la función: ${missing.join(", ")}.`,
    );
  }
  return {
    token: token!,
    storeId: storeId!,
    responseUrl: responseUrl!,
    cancellationUrl: cancellationUrl!,
  };
}

// --- Errores -----------------------------------------------------------------

/**
 * Error de una llamada a Payphone. Conserva `message`/`errorCode` del proveedor
 * para el LOG del servidor. Nunca se devuelve al cliente tal cual: las funciones
 * responden un mensaje propio (no filtrar detalles del gateway al navegador).
 */
export class PayphoneError extends Error {
  readonly httpStatus: number;
  readonly errorCode?: number | string;

  constructor(message: string, httpStatus: number, errorCode?: number | string) {
    super(message);
    this.name = "PayphoneError";
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
  }
}

// --- Tipos de las respuestas del proveedor -----------------------------------

interface PayphoneErrorBody {
  message?: string;
  errorCode?: number | string;
  errors?: unknown;
}

/** Respuesta del Prepare. `paymentId` puede venir como número o string. */
export interface PreparedPayment {
  paymentId: string;
  /** URL del formulario de tarjeta. Es a donde redirige la landing. */
  payWithCard: string;
  /** URL del flujo con la app de Payphone. No se usa hoy (solo tarjeta). */
  payWithPayPhone?: string;
}

/**
 * Respuesta del Confirm V2. Se tipa lo que se usa y se deja abierto el resto
 * (se guarda entero en webhook_events.payload para auditoría).
 */
export interface PayphoneConfirmResponse {
  /** 3 = Approved, 2 = Canceled. Es la verdad del cobro. */
  statusCode: number;
  transactionStatus?: string;
  authorizationCode?: string;
  /** Id de la transacción en Payphone. Se guarda como bigint. */
  transactionId?: number;
  /** Monto en CENTAVOS. Debe coincidir con PRICE_CENTS. */
  amount?: number;
  clientTransactionId?: string;
  email?: string;
  phoneNumber?: string;
  document?: string;
  cardBrand?: string;
  bin?: string;
  lastDigits?: string;
  date?: string;
  reference?: string;
  currency?: string;
  [key: string]: unknown;
}

// --- Operaciones -------------------------------------------------------------

export interface PreparePaymentInput {
  /** uuid del intent = clientTransactionId. Debe ser único por intento. */
  clientTransactionId: string;
  email: string;
  /** Texto que ve el usuario en el formulario de pago. Payphone lo acota. */
  reference: string;
}

/**
 * Paso 1: pide el link de pago. No cobra nada todavía.
 */
export async function preparePayment(
  input: PreparePaymentInput,
): Promise<PreparedPayment> {
  const env = payphoneEnv();

  const body = {
    amount: PRICE_CENTS,
    amountWithoutTax: 0,
    amountWithTax: PRICE_WITH_TAX_CENTS,
    tax: TAX_CENTS,
    clientTransactionId: input.clientTransactionId,
    currency: CURRENCY,
    storeId: env.storeId,
    reference: input.reference,
    responseUrl: env.responseUrl,
    cancellationUrl: env.cancellationUrl,
    email: input.email,
  };

  const data = await callPayphone<
    PreparedPayment & { paymentId?: string | number }
  >("/Prepare", env.token, body);

  const paymentId = data.paymentId === undefined || data.paymentId === null
    ? ""
    : String(data.paymentId);
  const payWithCard = typeof data.payWithCard === "string" ? data.payWithCard : "";
  if (!paymentId || !payWithCard) {
    throw new PayphoneError(
      `Prepare devolvió una respuesta incompleta (paymentId="${paymentId}", payWithCard="${payWithCard}").`,
      200,
    );
  }

  return {
    paymentId,
    payWithCard,
    payWithPayPhone: typeof data.payWithPayPhone === "string"
      ? data.payWithPayPhone
      : undefined,
  };
}

export interface ConfirmPaymentInput {
  /** `id` que Payphone puso en la query del responseUrl (entero). */
  id: number;
  /** El clientTransactionId original (uuid del intent). */
  clientTxId: string;
}

/**
 * Paso 3: confirma (captura) el cobro. OBLIGATORIO dentro de 5 min o Payphone
 * reversa. NO es idempotente: llamarlo dos veces puede devolver error.
 */
export async function confirmPayment(
  input: ConfirmPaymentInput,
): Promise<PayphoneConfirmResponse> {
  const env = payphoneEnv();

  const data = await callPayphone<PayphoneConfirmResponse>(
    "/V2/Confirm",
    env.token,
    { id: input.id, clientTxId: input.clientTxId },
  );

  if (typeof data.statusCode !== "number") {
    throw new PayphoneError(
      `Confirm devolvió una respuesta sin statusCode: ${truncate(JSON.stringify(data))}`,
      200,
    );
  }
  return data;
}

// --- Transporte --------------------------------------------------------------

/**
 * POST JSON con Bearer y timeout. Normaliza los dos formatos de fallo del
 * proveedor: HTTP 4xx/5xx y HTTP 200 con `{ message, errorCode }` en el body.
 * Loguea el cuerpo COMPLETO del error server-side (nunca viaja al cliente).
 */
async function callPayphone<T>(
  path: string,
  token: string,
  body: unknown,
): Promise<T> {
  const url = `${PAYPHONE_API_BASE}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new PayphoneError(`No hubo respuesta de Payphone en ${path}: ${reason}`, 0);
  }

  const raw = await res.text();
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // Respuesta no-JSON (HTML de error del gateway, por ejemplo).
  }

  if (!res.ok) {
    const err = (parsed ?? {}) as PayphoneErrorBody;
    console.error(
      `payphone: ${path} respondió HTTP ${res.status}. body=${truncate(raw)}`,
    );
    throw new PayphoneError(
      err.message ?? `Payphone respondió HTTP ${res.status} en ${path}.`,
      res.status,
      err.errorCode,
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    console.error(`payphone: ${path} respondió un body no-JSON. body=${truncate(raw)}`);
    throw new PayphoneError(`Payphone devolvió un body no-JSON en ${path}.`, res.status);
  }

  // 200 con forma de error: `{ message, errorCode }` y nada útil.
  const maybeError = parsed as PayphoneErrorBody;
  if (maybeError.errorCode !== undefined && maybeError.message !== undefined) {
    console.error(
      `payphone: ${path} respondió 200 con error del proveedor. body=${truncate(raw)}`,
    );
    throw new PayphoneError(maybeError.message, res.status, maybeError.errorCode);
  }

  return parsed as T;
}

/** Acota lo que se loguea: los bodies del gateway pueden ser enormes. */
function truncate(text: string, max = 2000): string {
  return text.length > max ? `${text.slice(0, max)}…[truncado]` : text;
}

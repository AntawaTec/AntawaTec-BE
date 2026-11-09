// =============================================================================
// _shared/billing/config.ts
// Configuración del proveedor de facturación desde el entorno de la función.
//
// NO HAY DRY-RUN. A diferencia del WhatsApp/correo (que tienen un modo sandbox
// que marca filas como enviadas sin mandar nada), acá un "modo de prueba" que
// marcara una factura como `authorized` sería un comprobante fiscal falso. Sin
// credenciales del proveedor las funciones responden 500 "Configuración del
// servidor incompleta." y no tocan ninguna factura. Para probar sin SRI real, la
// empresa se crea en ambiente `test` del proveedor (SRI de pruebas).
// =============================================================================

import { AutorizadorEcProvider } from "./autorizadorec.ts";
import type { BillingProvider, FetchLike } from "./provider.ts";

export const MISSING_CONFIG_MESSAGE = "Configuración del servidor incompleta.";

/**
 * Proveedor configurado, o null si falta algo obligatorio:
 *   AUTORIZADOREC_BASE_URL     p. ej. https://api.autorizadorec.com/api/v1
 *   AUTORIZADOREC_ACCOUNT_KEY  ak_… de la cuenta multiempresa
 * Opcional (solo para CREAR empresas): AUTORIZADOREC_PLAN_ID.
 */
export function providerFromEnv(fetchFn?: FetchLike): BillingProvider | null {
  const baseUrl = (Deno.env.get("AUTORIZADOREC_BASE_URL") ?? "").trim();
  const accountKey = (Deno.env.get("AUTORIZADOREC_ACCOUNT_KEY") ?? "").trim();
  if (!baseUrl || !accountKey) return null;
  const planRaw = (Deno.env.get("AUTORIZADOREC_PLAN_ID") ?? "").trim();
  const planId = /^[0-9]+$/.test(planRaw) ? Number(planRaw) : null;
  return new AutorizadorEcProvider({ baseUrl, accountKey, planId, fetch: fetchFn });
}

/** ¿Se puede crear una empresa nueva? (POST /client/companies exige planId). */
export function canCreateCompanies(): boolean {
  return /^[0-9]+$/.test((Deno.env.get("AUTORIZADOREC_PLAN_ID") ?? "").trim());
}

/** Secreto con el que el proveedor firma los webhooks (uno para todas las empresas). */
export function webhookSecretFromEnv(): string | null {
  const s = (Deno.env.get("AUTORIZADOREC_WEBHOOK_SECRET") ?? "").trim();
  return s || null;
}

/** URL pública de invoice-webhook que se registra en cada empresa del proveedor. */
export function webhookUrlFromEnv(): string | null {
  const base = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  return base ? `${base}/functions/v1/invoice-webhook` : null;
}

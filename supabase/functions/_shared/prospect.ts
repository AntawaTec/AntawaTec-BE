// =============================================================================
// _shared/prospect.ts
// Validación de los datos que manda un PROSPECTO ANÓNIMO desde la landing
// (razón social + email). Extraída de bank-transfer-intake para que el embudo
// bancario y el de tarjeta (payphone-prepare) validen EXACTAMENTE igual: mismos
// límites, misma normalización y —importante para el copy de la landing— los
// MISMOS mensajes de error.
//
// Devuelven un resultado discriminado en vez de lanzar: el caller decide el
// código HTTP (siempre 400 vía badRequest) sin envolver todo en try/catch.
// =============================================================================

export const MAX_BUSINESS_NAME = 120;
export const MAX_EMAIL = 254;

// Regex deliberadamente laxa: valida la FORMA, no la existencia del buzón. La
// verificación real es que el magic link del provisioning llegue.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/**
 * Razón social del taller: obligatoria, 1–120 caracteres tras `trim()`.
 * Acepta `unknown` porque las fuentes son `FormData.get()` (string | File | null)
 * y `JSON.parse()` (cualquier cosa).
 */
export function validateBusinessName(raw: unknown): ValidationResult<string> {
  const businessName = typeof raw === "string" ? raw.trim() : "";
  if (!businessName || businessName.length > MAX_BUSINESS_NAME) {
    return { ok: false, message: "businessName es obligatorio (1–120 caracteres)." };
  }
  return { ok: true, value: businessName };
}

/**
 * Email del dueño: obligatorio, ≤254 caracteres, con forma válida. Se devuelve
 * NORMALIZADO (trim + minúsculas) porque es el ancla de idempotencia de
 * provisionTenant y la clave de los caps anti-abuso.
 */
export function validateEmail(raw: unknown): ValidationResult<string> {
  const email = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!email || email.length > MAX_EMAIL || !EMAIL_RE.test(email)) {
    return { ok: false, message: "email es obligatorio y debe ser una dirección válida." };
  }
  return { ok: true, value: email };
}

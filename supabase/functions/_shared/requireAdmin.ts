// =============================================================================
// _shared/requireAdmin.ts
// Verificación de "quien llama es antawa_admin", compartida por las funciones
// que invoca el admin desde el navegador (`bank-transfer-approval`,
// `subscription-renewal-approval`). Extraída de bank-transfer-approval SIN
// cambio de comportamiento: mismos códigos HTTP y mismos mensajes.
//
// Por qué in-code y no `verify_jwt = true` en el gateway: el preflight OPTIONS
// del navegador NO lleva Authorization y el gateway lo mataría con 401 antes del
// CORS. Además el gateway solo confirma "hay un JWT", no que sea de un admin —
// esta verificación es estrictamente más fuerte:
//   1. el Bearer se valida criptográficamente contra GoTrue (`auth.getUser`),
//   2. el rol se lee de `public.profiles` con el cliente service_role, no del
//      JWT (un claim de rol en el token sería manipulable/obsoleto).
// =============================================================================

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { forbidden, serverError, unauthorized } from "./response.ts";

/** Éxito = el uuid del admin; fallo = la Response HTTP lista para devolver. */
export type AdminCheck =
  | { ok: true; userId: string }
  | { ok: false; response: Response };

/** `Authorization: Bearer <token>` → token, o null si falta/está mal formado. */
export function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

/**
 * Exige que el caller sea un `antawa_admin` autenticado.
 * `label` es el nombre de la función que llama, solo para los logs.
 */
export async function requireAntawaAdmin(
  admin: SupabaseClient,
  req: Request,
  label: string,
): Promise<AdminCheck> {
  const token = extractBearer(req.headers.get("Authorization"));
  if (!token) {
    return { ok: false, response: unauthorized("Falta el token de autorización.") };
  }

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return { ok: false, response: unauthorized("Token inválido o expirado.") };
  }
  const userId = userData.user.id;

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr) {
    console.error(`${label}: lectura de profile falló:`, profileErr);
    return {
      ok: false,
      response: serverError("No se pudo verificar el rol del usuario."),
    };
  }
  if (!profile || profile.role !== "antawa_admin") {
    return { ok: false, response: forbidden("Se requiere rol antawa_admin.") };
  }

  return { ok: true, userId };
}

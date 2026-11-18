// =============================================================================
// _shared/requireOwner.ts
// Verificación de "quien llama es el DUEÑO de un taller", compartida por las
// funciones que invoca el dueño desde la PWA (`technician-access`,
// `billing-setup`, `invoice-emit`). Extraída de technician-access SIN cambio de
// comportamiento: mismo orden de chequeos, mismos códigos HTTP y mismos mensajes
// (el 403 recibe el texto de cada función).
//
// Gemela de `_shared/requireAdmin.ts` y con el mismo racional para hacerlo
// in-code y no con `verify_jwt = true`: el preflight OPTIONS del navegador no
// lleva Authorization (el gateway lo mataría con 401 antes del CORS), y el
// gateway solo confirma "hay un JWT", no el rol ni el taller:
//   1. el Bearer se valida criptográficamente contra GoTrue (`auth.getUser`),
//   2. rol y taller se leen de `public.profiles` con el cliente service_role, no
//      del JWT (un claim en el token sería manipulable/obsoleto).
// El `shopId` devuelto es la ÚNICA fuente de tenancy de la función que llama:
// toda lectura/escritura posterior se filtra por él.
// =============================================================================

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { extractBearer } from "./requireAdmin.ts";
import { forbidden, serverError, unauthorized } from "./response.ts";

/** Éxito = uuid del dueño + su taller; fallo = la Response HTTP lista para devolver. */
export type OwnerCheck =
  | { ok: true; userId: string; shopId: string }
  | { ok: false; response: Response };

/**
 * Exige que el caller sea un `shop_owner` autenticado con taller.
 * `label` es el nombre de la función que llama, solo para los logs.
 * `forbiddenMessage` es el texto del 403 (cada función tiene el suyo).
 */
export async function requireShopOwner(
  admin: SupabaseClient,
  req: Request,
  label: string,
  forbiddenMessage: string,
): Promise<OwnerCheck> {
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
    .select("role, shop_id")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr) {
    console.error(`${label}: lectura de profile falló:`, profileErr);
    return {
      ok: false,
      response: serverError("No se pudo verificar el rol del usuario."),
    };
  }
  if (!profile || profile.role !== "shop_owner" || !profile.shop_id) {
    return { ok: false, response: forbidden(forbiddenMessage) };
  }

  return { ok: true, userId, shopId: profile.shop_id as string };
}

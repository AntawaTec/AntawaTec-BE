// =============================================================================
// owner-access/index.ts
// Restauración del acceso del DUEÑO de un taller, invocada por un antawa_admin
// desde el dashboard de Antawa (navegador). Existe por un caso concreto de prod:
// provisionTenant da de alta al dueño con `inviteUserByEmail`; si el dueño nunca
// abre ese invite, su usuario queda con `email_confirmed_at` NULL y, como el
// proyecto tiene los signups cerrados, GoTrue responde "Signups not allowed" a
// cualquier magic link que pida después (supabase/auth#1494). Para el dueño el
// síntoma es "el enlace mágico no funciona" y no tiene forma de salir solo.
//
// Acciones:
//   - status: diagnóstico (email, si confirmó, cuándo se lo invitó, último login).
//   - reinvite: re-envía el email de invitación. GoTrue re-envía el invite a un
//     usuario existente NO confirmado y solo responde `email_exists` si ya está
//     confirmado; en ese caso devolvemos 409 (el dueño ya puede pedir un magic
//     link normal o el admin le fija una contraseña temporal).
//   - set_password: fija una contraseña temporal que el admin le pasa en mano.
//     Además confirma el email, lo que destraba también el magic link.
//
// Alcance: SOLO toca el profile con role = 'shop_owner' del taller pedido. Un
// antawa_admin o un técnico jamás se resuelven como "dueño" (el filtro por rol
// está en la consulta, no en un chequeo posterior).
//
// Seguridad: el gateway corre con verify_jwt = false (ver config.toml) para que
// el preflight OPTIONS —que el navegador envía SIN Authorization— no muera con
// 401. La auth real (JWT validado contra GoTrue + rol antawa_admin) se hace
// DENTRO, vía _shared/requireAdmin.ts. La contraseña nunca se loggea.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import { isAlreadyRegistered } from "../_shared/authAdmin.ts";
import { requireAntawaAdmin } from "../_shared/requireAdmin.ts";
import {
  badRequest,
  json,
  methodNotAllowed,
  notFound,
  ok,
  preflight,
  serverError,
} from "../_shared/response.ts";

const LABEL = "owner-access";

const MIN_PASSWORD_LENGTH = 8; // alineado con SecuritySection del FE (GoTrue exige 6)

const ALREADY_CONFIRMED_MSG =
  "El dueño ya activó su cuenta: puede pedir un enlace nuevo desde la pantalla " +
  "de ingreso, o fijale una contraseña temporal.";

type Action = "status" | "reinvite" | "set_password";

interface RequestBody {
  action?: Action;
  shopId?: string;
  password?: string;
}

interface OwnerProfile {
  id: string;
  full_name: string | null;
}

/** Usuario de auth del dueño (subset de lo que devuelve GoTrue admin). */
interface OwnerUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  invited_at?: string | null;
  last_sign_in_at?: string | null;
  user_metadata?: Record<string, unknown>;
}

type OwnerLookup =
  | { ok: true; profile: OwnerProfile; user: OwnerUser }
  | { ok: false; response: Response };

Deno.serve(async (req) => {
  // 1) Preflight CORS antes de exigir auth (el navegador no manda Bearer aquí).
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error("owner-access: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  // 2) Identidad + autorización: solo un antawa_admin (_shared/requireAdmin.ts).
  const auth = await requireAntawaAdmin(admin, req, LABEL);
  if (!auth.ok) return auth.response;
  const callerId = auth.userId;

  // 3) Body.
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }
  const action = body?.action;
  if (action !== "status" && action !== "reinvite" && action !== "set_password") {
    return badRequest("action debe ser 'status', 'reinvite' o 'set_password'.");
  }
  const shopId = typeof body.shopId === "string" ? body.shopId.trim() : "";
  if (!shopId) return badRequest("Falta shopId.");

  // Validar la contraseña ANTES de tocar la DB (400 barato, sin lecturas).
  const password = typeof body.password === "string" ? body.password : "";
  if (action === "set_password" && password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(
      `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    );
  }

  try {
    // 4) Resolver el dueño del taller (404 si falta cualquier eslabón).
    const owner = await findOwner(admin, shopId);
    if (!owner.ok) return owner.response;
    const { profile, user } = owner;
    const email = user.email ?? "";
    const confirmed = Boolean(user.email_confirmed_at);

    if (action === "status") {
      return ok({
        status: "ok",
        ownerUserId: user.id,
        email,
        fullName: profile.full_name,
        confirmed,
        invitedAt: user.invited_at ?? null,
        lastSignInAt: user.last_sign_in_at ?? null,
      });
    }

    if (action === "reinvite") {
      // Un usuario confirmado ya puede pedir magic link; re-invitarlo no aplica
      // (GoTrue respondería email_exists).
      if (confirmed) return json(409, { error: ALREADY_CONFIRMED_MSG });

      const redirectTo = Deno.env.get("ONBOARDING_REDIRECT_URL") || undefined;
      const { error } = await admin.auth.admin.inviteUserByEmail(email, {
        // Conservar el metadata original (full_name, marcas de provisioning...).
        data: user.user_metadata ?? {},
        ...(redirectTo ? { redirectTo } : {}),
      });
      if (error) {
        // Carrera: el dueño confirmó entre nuestra lectura y el invite.
        if (isAlreadyRegistered(error)) {
          return json(409, { error: ALREADY_CONFIRMED_MSG });
        }
        throw new Error(`inviteUserByEmail falló: ${error.message}`);
      }

      console.log(
        `owner-access: reinvite sobre dueño ${user.id} del taller ${shopId} ` +
          `por admin ${callerId}.`,
      );
      return ok({ status: "reinvited", email });
    }

    // action === "set_password"
    // email_confirm: true — además de fijar la clave, confirma el email: es la
    // causa raíz del "magic link no funciona" (usuario invitado sin confirmar ⇒
    // "Signups not allowed"), así que el dueño queda destrabado por ambas vías.
    // temp_password: true — lo lee el FE para mostrar el aviso "cambiá tu
    // contraseña"; el FE lo vuelve a false cuando el dueño la cambia.
    const { error: updErr } = await admin.auth.admin.updateUserById(user.id, {
      password,
      email_confirm: true,
      user_metadata: { ...(user.user_metadata ?? {}), temp_password: true },
    });
    if (updErr) throw new Error(`updateUserById falló: ${updErr.message}`);

    console.log(
      `owner-access: set_password sobre dueño ${user.id} del taller ${shopId} ` +
        `por admin ${callerId}.`,
    );
    return ok({ status: "password_set", email });
  } catch (e) {
    console.error(
      `owner-access: error en ${action} para taller ${shopId} (admin ${callerId}):`,
      e,
    );
    return serverError("No se pudo completar la operación. Probá de nuevo.");
  }
});

/**
 * Taller → profile shop_owner → usuario de auth. El filtro por rol va en la
 * consulta: un antawa_admin (shop_id null) o un técnico del taller jamás se
 * resuelven como dueño. Si hubiera más de un shop_owner, se toma el más viejo
 * (el que creó provisionTenant).
 */
async function findOwner(
  admin: SupabaseClient,
  shopId: string,
): Promise<OwnerLookup> {
  const { data: shop, error: shopErr } = await admin
    .from("shops")
    .select("id, name")
    .eq("id", shopId)
    .maybeSingle();
  if (shopErr) {
    // Un shopId que no es uuid llega acá como 22P02: es "no existe", no un 500.
    if (shopErr.code === "22P02") {
      return { ok: false, response: notFound("No encontramos ese taller.") };
    }
    throw new Error(`Lectura del taller falló: ${shopErr.message}`);
  }
  if (!shop) {
    return { ok: false, response: notFound("No encontramos ese taller.") };
  }

  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("id, full_name")
    .eq("shop_id", shopId)
    .eq("role", "shop_owner")
    .order("created_at")
    .limit(1)
    .maybeSingle();
  if (profErr) throw new Error(`Lectura del dueño falló: ${profErr.message}`);
  if (!profile) {
    return {
      ok: false,
      response: notFound("Ese taller no tiene un dueño con cuenta."),
    };
  }

  const { data: userData, error: userErr } = await admin.auth.admin.getUserById(
    profile.id as string,
  );
  if (userErr || !userData?.user) {
    console.error(
      `owner-access: el profile ${profile.id} del taller ${shopId} no tiene ` +
        `usuario de auth:`,
      userErr ?? "sin usuario",
    );
    return {
      ok: false,
      response: notFound("El dueño no tiene usuario de acceso."),
    };
  }

  return {
    ok: true,
    profile: profile as OwnerProfile,
    user: userData.user as OwnerUser,
  };
}

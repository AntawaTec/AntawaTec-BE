// =============================================================================
// technician-access/index.ts
// Alta y revocación del LOGIN de un técnico, invocada por el DUEÑO del taller
// desde la PWA (navegador). Un técnico es una fila de `technicians` (recurso
// asignable a órdenes); darle acceso significa crear su usuario de auth + su
// profile con role='technician' y enlazar `technicians.profile_id`. Nada de eso
// puede hacerlo el cliente (profiles no tiene política INSERT; GoTrue admin es
// service_role), por eso existe esta función.
//
// Acciones:
//   - invite: crea el usuario y le manda el email de invitación (template invite,
//     token_hash + verifyOtp en /auth/callback del FE). El técnico define su
//     contraseña al entrar.
//   - create: crea el usuario con una contraseña temporal que el dueño le
//     comparte en mano (técnicos sin acceso cómodo a su correo).
//   - revoke: borra el usuario de auth (auth.admin.deleteUser). La cascada borra
//     el profile y el FK deja technicians.profile_id = null: el técnico vuelve a
//     ser staff sin login (0021), su historial queda intacto (referencia
//     technicians.id) y la RLS lo deniega al instante aunque su JWT siga vivo
//     (~1h): sin profile, current_technician_id() devuelve NULL. Delete y no ban:
//     re-otorgar es simplemente volver a invitar (el email queda libre).
//
// Re-entrante (mismo racional que provisionTenant: GoTrue y Postgres no comparten
// transacción): el usuario de técnico nace con el marker user_metadata
// { invited_as: 'technician', technician_id, shop_id }. Si una corrida muere entre
// "crear usuario" y "enlazar", el retry encuentra el usuario por email, reconoce
// SU marker y lo adopta (completa profile + link). Un usuario sin ese marker
// jamás se adopta (no secuestrar cuentas ajenas, p. ej. un dueño del funnel).
//
// Seguridad: el gateway corre con verify_jwt = false (ver config.toml) para que
// el preflight OPTIONS —que el navegador envía SIN Authorization— no muera con
// 401. La auth real se hace DENTRO: JWT validado contra GoTrue + rol shop_owner
// + el técnico debe pertenecer a SU taller (404 indistinguible de inexistente,
// para no filtrar existencia cross-shop).
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import { findAuthUserByEmail, isAlreadyRegistered } from "../_shared/authAdmin.ts";
import {
  badRequest,
  forbidden,
  json,
  methodNotAllowed,
  notFound,
  ok,
  preflight,
  serverError,
  unauthorized,
} from "../_shared/response.ts";

const MIN_PASSWORD_LENGTH = 8; // alineado con SecuritySection del FE (GoTrue exige 6)
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Action = "invite" | "create" | "revoke";

interface RequestBody {
  action?: Action;
  technicianId?: string;
  email?: string;
  password?: string;
}

interface TechnicianRow {
  id: string;
  shop_id: string;
  full_name: string;
  is_active: boolean;
  profile_id: string | null;
}

Deno.serve(async (req) => {
  // 1) Preflight CORS antes de exigir auth (el navegador no manda Bearer aquí).
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error("technician-access: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  // 2) Identidad del caller: Bearer validado criptográficamente por GoTrue.
  const token = extractBearer(req.headers.get("Authorization"));
  if (!token) return unauthorized("Falta el token de autorización.");

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return unauthorized("Token inválido o expirado.");
  }
  const callerId = userData.user.id;

  // 3) Autorización: solo el dueño del taller gestiona accesos.
  const { data: callerProfile, error: profileErr } = await admin
    .from("profiles")
    .select("role, shop_id")
    .eq("id", callerId)
    .maybeSingle();
  if (profileErr) {
    console.error("technician-access: lectura de profile falló:", profileErr);
    return serverError("No se pudo verificar el rol del usuario.");
  }
  if (
    !callerProfile ||
    callerProfile.role !== "shop_owner" ||
    !callerProfile.shop_id
  ) {
    return forbidden("Solo el dueño del taller puede gestionar accesos.");
  }
  const shopId = callerProfile.shop_id as string;

  // 4) Body.
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }
  const action = body.action;
  if (action !== "invite" && action !== "create" && action !== "revoke") {
    return badRequest("action debe ser 'invite', 'create' o 'revoke'.");
  }
  const technicianId =
    typeof body.technicianId === "string" ? body.technicianId.trim() : "";
  if (!technicianId) return badRequest("Falta technicianId.");

  try {
    // 5) El técnico, SIEMPRE acotado al taller del caller (404 uniforme).
    const { data: technician, error: techErr } = await admin
      .from("technicians")
      .select("id, shop_id, full_name, is_active, profile_id")
      .eq("id", technicianId)
      .eq("shop_id", shopId)
      .maybeSingle();
    if (techErr) throw new Error(`Lectura del técnico falló: ${techErr.message}`);
    if (!technician) return notFound("No encontramos ese técnico en tu taller.");

    if (action === "revoke") {
      return await revokeAccess(admin, technician as TechnicianRow, shopId, callerId);
    }
    return await grantAccess(
      admin,
      technician as TechnicianRow,
      shopId,
      callerId,
      action,
      body,
    );
  } catch (e) {
    console.error(
      `technician-access: error en ${action} para técnico ${technicianId}:`,
      e,
    );
    return serverError("No se pudo completar la operación. Probá de nuevo.");
  }
});

// --- Alta (invite / create) --------------------------------------------------

async function grantAccess(
  admin: SupabaseClient,
  technician: TechnicianRow,
  shopId: string,
  callerId: string,
  action: "invite" | "create",
  body: RequestBody,
): Promise<Response> {
  const email = normalizeEmail(body.email);
  if (!email || !EMAIL_RE.test(email)) {
    return badRequest("Ingresá un correo válido.");
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (action === "create" && password.length < MIN_PASSWORD_LENGTH) {
    return badRequest(
      `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
    );
  }

  // Dos perillas distintas: is_active (aparece en pickers) y acceso (login).
  // No tiene sentido dar login a alguien que ya no trabaja en el taller.
  if (!technician.is_active) {
    return json(409, { error: "Reactivá al técnico antes de darle acceso." });
  }

  // ¿El técnico ya tiene login? Idempotente si es el MISMO email; conflicto si no.
  const existing = await findAuthUserByEmail(admin, email);
  if (technician.profile_id) {
    if (existing && existing.id === technician.profile_id) {
      return ok({
        status: "already_linked",
        technicianId: technician.id,
        email,
        alreadyLinked: true,
      });
    }
    return json(409, {
      error:
        "Este técnico ya tiene acceso. Quitáselo primero si querés cambiar el correo.",
    });
  }

  // Resolver el usuario de auth. Si el email ya existe, solo puede ser un huérfano
  // NUESTRO (marker de ESTE técnico, de una corrida a medias): lo borramos y creamos
  // fresco, en vez de adoptarlo a medias — un huérfano nacido de un invite no tiene
  // la contraseña que el owner está definiendo ahora, y uno viejo tendría un link de
  // invite vencido; recrear garantiza contraseña/email de invitación correctos.
  // (technician.profile_id es null acá, así que el huérfano jamás está enlazado.)
  if (existing) {
    if (!hasOurMarker(existing, technician.id, shopId)) {
      // Cuenta ajena (dueño, admin, técnico de otro taller...): jamás tocar.
      return json(409, { error: "Ese correo ya tiene una cuenta en AntawaTec." });
    }
    // Releer el link JUSTO antes de borrar: en un doble submit (dos pestañas), el
    // "huérfano" puede ser el usuario que la otra corrida acaba de crear y enlazar
    // — el marker solo dice que es de este técnico, no que esté incompleto.
    const fresh = await readTechnicianLink(admin, technician.id, shopId);
    if (fresh) {
      if (fresh === existing.id) {
        return ok({
          status: "already_linked",
          technicianId: technician.id,
          email,
          alreadyLinked: true,
        });
      }
      return json(409, {
        error:
          "Este técnico ya tiene acceso. Quitáselo primero si querés cambiar el correo.",
      });
    }
    console.log(
      `technician-access: recreando usuario huérfano ${existing.id} (${email}) ` +
        `para técnico ${technician.id}.`,
    );
    const { error: delErr } = await admin.auth.admin.deleteUser(existing.id);
    if (delErr && !isUserNotFound(delErr)) {
      throw new Error(`No se pudo limpiar el usuario huérfano: ${delErr.message}`);
    }
  }
  const created = await createAuthUser(admin, action, email, password, technician, shopId);
  if (created.conflict) {
    // Carrera: otra corrida re-creó el email entre el delete y el create. Retry sano.
    return json(409, { error: "Ese correo ya tiene una cuenta en AntawaTec." });
  }
  const userId = created.userId;

  // Profile del técnico (PK = userId). Re-entrante: si ya existe (huérfano que
  // murió después de este paso), verificar que sea EL profile esperado.
  const profileOk = await ensureTechnicianProfile(
    admin,
    userId,
    shopId,
    technician.full_name,
  );
  if (!profileOk) {
    // El profile existente no es un técnico de este taller: datos corruptos.
    // No tocar nada (podría ser una cuenta real) -> 500 para que se investigue.
    console.error(
      `technician-access: el usuario ${userId} (${email}) tiene un profile que ` +
        `no es technician de ${shopId}; se aborta sin modificar.`,
    );
    return serverError("No se pudo completar la operación. Probá de nuevo.");
  }

  // Enlazar technicians.profile_id. Condicionado a "sigue sin link" para que una
  // carrera (doble click / dos pestañas) no pise un link ya hecho.
  const { data: linked, error: linkErr } = await admin
    .from("technicians")
    .update({ profile_id: userId })
    .eq("id", technician.id)
    .eq("shop_id", shopId)
    .is("profile_id", null)
    .select("id");
  if (linkErr || !linked || linked.length === 0) {
    // No se pudo enlazar (error o carrera). Compensación: borrar el usuario recién
    // creado (la cascada limpia el profile). Si la compensación falla, queda un
    // huérfano CON marker que el próximo retry adopta — no hay estado bloqueante.
    console.error(
      `technician-access: enlace de técnico ${technician.id} falló:`,
      linkErr ?? "0 filas (carrera)",
    );
    const { error: undoErr } = await admin.auth.admin.deleteUser(userId);
    if (undoErr) {
      console.error(
        `technician-access: compensación deleteUser(${userId}) falló:`,
        undoErr,
      );
    }
    return serverError("No se pudo completar la operación. Probá de nuevo.");
  }

  console.log(
    `technician-access: técnico ${technician.id} con acceso ${action} ` +
      `(user ${userId}) por owner ${callerId}.`,
  );
  return ok({
    status: action === "invite" ? "invited" : "created",
    technicianId: technician.id,
    email,
  });
}

/** Crea el usuario de auth con el marker de idempotencia en user_metadata. */
async function createAuthUser(
  admin: SupabaseClient,
  action: "invite" | "create",
  email: string,
  password: string,
  technician: TechnicianRow,
  shopId: string,
): Promise<{ userId: string; conflict?: false } | { conflict: true; userId?: never }> {
  const marker = {
    full_name: technician.full_name,
    invited_as: "technician",
    technician_id: technician.id,
    shop_id: shopId,
  };

  if (action === "invite") {
    const redirectTo = Deno.env.get("ONBOARDING_REDIRECT_URL") || undefined;
    const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
      data: marker,
      ...(redirectTo ? { redirectTo } : {}),
    });
    if (!error && data?.user) return { userId: data.user.id };
    if (error && isAlreadyRegistered(error)) return { conflict: true };
    throw new Error(`inviteUserByEmail falló: ${error?.message ?? "sin usuario"}`);
  }

  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true, // el dueño responde por el email; sin mail de confirmación
    user_metadata: marker,
  });
  if (!error && data?.user) return { userId: data.user.id };
  if (error && isAlreadyRegistered(error)) return { conflict: true };
  throw new Error(`createUser falló: ${error?.message ?? "sin usuario"}`);
}

/** ¿El usuario lleva NUESTRO marker para ESTE técnico de ESTE taller? */
function hasOurMarker(
  user: { user_metadata?: Record<string, unknown> },
  technicianId: string,
  shopId: string,
): boolean {
  const meta = user.user_metadata ?? {};
  return (
    meta.invited_as === "technician" &&
    meta.technician_id === technicianId &&
    meta.shop_id === shopId
  );
}

/**
 * Asegura el profile del técnico (PK = userId, role technician, shop del caller).
 * Devuelve false si existe un profile INCOMPATIBLE (otro rol u otro taller).
 * Si el insert falla por otra causa, compensa borrando el usuario y lanza.
 */
async function ensureTechnicianProfile(
  admin: SupabaseClient,
  userId: string,
  shopId: string,
  fullName: string,
): Promise<boolean> {
  const { data: existing, error: readErr } = await admin
    .from("profiles")
    .select("id, role, shop_id")
    .eq("id", userId)
    .maybeSingle();
  if (readErr) throw new Error(`Lectura de profile falló: ${readErr.message}`);
  if (existing) {
    return existing.role === "technician" && existing.shop_id === shopId;
  }

  const { error } = await admin.from("profiles").insert({
    id: userId,
    shop_id: shopId,
    role: "technician",
    full_name: fullName,
  });
  if (error) {
    if (error.code === "23505") {
      // Carrera: otra corrida lo insertó. Releer y validar compatibilidad.
      const { data: raced } = await admin
        .from("profiles")
        .select("role, shop_id")
        .eq("id", userId)
        .maybeSingle();
      return raced?.role === "technician" && raced?.shop_id === shopId;
    }
    // Insert falló de verdad. Compensación best-effort: sin profile el usuario
    // es inservible (RLS lo deniega todo); mejor no dejarlo. Con marker, un
    // retry lo adoptaría igual si esta limpieza falla.
    const { error: undoErr } = await admin.auth.admin.deleteUser(userId);
    if (undoErr) {
      console.error(
        `technician-access: compensación deleteUser(${userId}) falló:`,
        undoErr,
      );
    }
    throw new Error(`No se pudo crear el profile: ${error.message}`);
  }
  return true;
}

// --- Revocación ----------------------------------------------------------------

async function revokeAccess(
  admin: SupabaseClient,
  technician: TechnicianRow,
  shopId: string,
  callerId: string,
): Promise<Response> {
  if (!technician.profile_id) {
    // Doble click / ya revocado: idempotente.
    return ok({
      status: "revoked",
      technicianId: technician.id,
      alreadyRevoked: true,
    });
  }

  // Backstop: JAMÁS borrar un usuario que no sea un técnico de ESTE taller,
  // aunque technicians.profile_id apunte a él por datos corruptos.
  const { data: targetProfile, error: readErr } = await admin
    .from("profiles")
    .select("role, shop_id")
    .eq("id", technician.profile_id)
    .maybeSingle();
  if (readErr) {
    throw new Error(`Lectura del profile a revocar falló: ${readErr.message}`);
  }
  if (!targetProfile) {
    // El profile ya no existe. Por el FK (on delete set null) esto significa que
    // OTRA corrida revocó entre nuestra lectura y acá (doble click en dos
    // pestañas): releer y tratarlo como ya-revocado, no como corrupción.
    const fresh = await readTechnicianLink(admin, technician.id, shopId);
    if (fresh !== technician.profile_id) {
      return ok({
        status: "revoked",
        technicianId: technician.id,
        alreadyRevoked: true,
      });
    }
    console.error(
      `technician-access: profile ${technician.profile_id} del técnico ` +
        `${technician.id} no existe pero sigue enlazado; se aborta sin borrar.`,
    );
    return serverError("No se pudo completar la operación. Probá de nuevo.");
  }
  if (targetProfile.role !== "technician" || targetProfile.shop_id !== shopId) {
    console.error(
      `technician-access: profile ${technician.profile_id} del técnico ` +
        `${technician.id} no es technician de ${shopId}; se aborta sin borrar.`,
    );
    return serverError("No se pudo completar la operación. Probá de nuevo.");
  }

  // deleteUser -> cascada borra profiles -> FK deja technicians.profile_id NULL.
  const { error: delErr } = await admin.auth.admin.deleteUser(
    technician.profile_id,
  );
  if (delErr) {
    if (isUserNotFound(delErr)) {
      // Carrera: la otra corrida borró el usuario primero. Mismo resultado final.
      return ok({
        status: "revoked",
        technicianId: technician.id,
        alreadyRevoked: true,
      });
    }
    throw new Error(`deleteUser falló: ${delErr.message}`);
  }

  console.log(
    `technician-access: acceso del técnico ${technician.id} revocado ` +
      `(user ${technician.profile_id}) por owner ${callerId}.`,
  );
  return ok({ status: "revoked", technicianId: technician.id });
}

// --- Helpers -------------------------------------------------------------------

/** Relee technicians.profile_id (estado fresco para decisiones bajo carrera). */
async function readTechnicianLink(
  admin: SupabaseClient,
  technicianId: string,
  shopId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("technicians")
    .select("profile_id")
    .eq("id", technicianId)
    .eq("shop_id", shopId)
    .maybeSingle();
  if (error) throw new Error(`Relectura del técnico falló: ${error.message}`);
  return (data?.profile_id as string | null) ?? null;
}

/** ¿El error de GoTrue admin significa "el usuario ya no existe"? */
function isUserNotFound(error: { code?: string; message?: string; status?: number }): boolean {
  return (
    error?.code === "user_not_found" ||
    error?.status === 404 ||
    (error?.message ?? "").toLowerCase().includes("user not found")
  );
}

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

function normalizeEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

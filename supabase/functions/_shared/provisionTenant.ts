// =============================================================================
// _shared/provisionTenant.ts
// Provisioning idempotente y re-entrante de un tenant (taller) del ecosistema
// Antawa. Es un módulo COMPARTIDO, no una Edge Function HTTP: lo invocan tanto
// `hotmart-webhook` como `bank-transfer-approval`.
//
// Por qué re-entrante en vez de transaccional:
//   Crear el usuario de auth (auth.admin.inviteUserByEmail) vive en GoTrue, un
//   sistema aparte de Postgres. No se puede envolver "crear usuario + filas de
//   DB" en una sola transacción. En su lugar cada paso COMPRUEBA-ANTES-DE-CREAR
//   usando anclas de identidad estables, de modo que una corrida que quedó a
//   medias se complete en la siguiente sin duplicar nada. Los webhooks se
//   disparan dos veces (y se pueden reintentar): esto es obligatorio.
//
// Anclas de idempotencia (de más fuerte a más débil):
//   1) auth.users por email  -> GoTrue garantiza email único. Es "la persona".
//   2) profiles.id (= auth.users.id, PK) -> enlaza usuario <-> shop. Si existe y
//      tiene shop_id, el tenant ya está provisionado.
//   3) shops.contact_email   -> permite reconocer un shop huérfano de una corrida
//      que creó el shop pero murió antes de crear el profile.
//
// Garantía de DB (migración 0011): las anclas 1-3 ya no son solo chequeos en la
// app. Hay UNIQUE constraints con nombre explícito que cierran las carreras de
// raíz, y este módulo se APOYA en ellas distinguiendo el error 23505 por nombre:
//   - shops_contact_email_unique           (un email = un taller)
//   - subscriptions_shop_provider_unique   (una subscription por taller/proveedor)
//
// `created` en el resultado es true SOLO si esta invocación creó el shop.
//
// service_role: el cliente que se recibe debe ser el admin (service_role); todas
// las escrituras saltan RLS, como manda CLAUDE.md para escrituras de plataforma.
// =============================================================================

import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import { findAuthUserByEmail, isAlreadyRegistered } from "./authAdmin.ts";

// --- Tipos públicos ----------------------------------------------------------

export type ProvisionProvider = "hotmart" | "bank_transfer";

export interface ProvisionTenantInput {
  /** Razón social del taller -> shops.name y base del slug. */
  businessName: string;
  /** Email del dueño. Ancla de idempotencia principal (auth.users es único). */
  email: string;
  /** Origen del alta. Coincide con el enum public.subscription_provider. */
  provider: ProvisionProvider;
  /** Plan contratado (texto libre). Opcional. */
  plan?: string;
  /**
   * URL de retorno para el magic link de la invitación (onboarding del dueño).
   * El caller la pasa desde su propio entorno; el módulo se mantiene libre de env.
   */
  redirectTo?: string;
}

export interface ProvisionTenantResult {
  shopId: string;
  ownerUserId: string;
  /** true solo si ESTA llamada creó el shop. false si ya existía o se completó. */
  created: boolean;
}

/** Roles de plataforma (enum public.user_role). */
type ProvisionRole = "antawa_admin" | "shop_owner";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Cuántas veces reintentar la LECTURA del shop ajeno tras un 23505 por
// contact_email (defensa ante lag de réplica de lectura). Si se agota, se aborta.
const CONTACT_EMAIL_READ_RETRIES = 6;

// --- Entrada principal -------------------------------------------------------

/**
 * Provisiona (o completa) el tenant del taller para un email dado.
 *
 * Idempotente y re-entrante: invocarla N veces con el mismo email produce un
 * único shop, un único usuario dueño, un único profile y una única subscription.
 *
 * @param admin Cliente de Supabase creado con la service_role key (salta RLS).
 */
export async function provisionTenant(
  admin: SupabaseClient,
  input: ProvisionTenantInput,
): Promise<ProvisionTenantResult> {
  const email = normalizeEmail(input.email);
  const businessName = input.businessName.trim();
  if (!email) throw new Error("provisionTenant: email vacío");
  if (!businessName) throw new Error("provisionTenant: businessName vacío");

  // 1) ¿Ya existe la persona (usuario de auth) y su profile? Anclas más fuertes.
  const ownerUser = await findAuthUserByEmail(admin, email);
  const ownerProfile = ownerUser
    ? await getProfileById(admin, ownerUser.id)
    : null;

  // 2) Guard: un admin de plataforma no puede ser dueño de taller. Si siguiéramos,
  //    crearíamos un shop que ensureProfile no podría enlazar -> shop huérfano.
  if (ownerProfile?.role === "antawa_admin") {
    throw new Error(
      `El email ${email} pertenece a un administrador de plataforma (antawa_admin); ` +
        `no se puede provisionar como dueño de taller.`,
    );
  }

  // 3) Resolver el shop.
  let shop: { id: string };
  let created = false;

  if (ownerProfile?.shop_id) {
    // El dueño ya tiene taller: reusar si coincide con el ancla de email;
    // abortar si diverge (apunta a OTRO shop) para no dejar datos inconsistentes.
    const shopByProfile = await getShopById(admin, ownerProfile.shop_id);
    if (!shopByProfile) {
      throw new Error(
        `Estado inconsistente: el profile de ${email} apunta al shop ` +
          `${ownerProfile.shop_id}, que no existe.`,
      );
    }
    const shopByEmail = await findShopByContactEmail(admin, email);
    if (shopByEmail && shopByEmail.id !== shopByProfile.id) {
      throw new Error(
        `El email ${email} ya es dueño del shop ${shopByProfile.id}, distinto del ` +
          `shop ${shopByEmail.id} asociado a ese contact_email. Conflicto de ` +
          `provisioning; se aborta para no dejar datos inconsistentes.`,
      );
    }
    shop = shopByProfile;
  } else {
    // Aún no hay profile-dueño: reusar un shop huérfano de una corrida a medias,
    // o crear uno nuevo.
    const orphan = await findShopByContactEmail(admin, email);
    if (orphan) {
      shop = orphan;
    } else {
      const result = await createShop(admin, businessName, email);
      shop = { id: result.id };
      created = result.created;
    }
  }

  // 4) Asegurar el usuario dueño (invitación por magic link, sin contraseña).
  const ownerUserId = ownerUser?.id ??
    (await inviteOwner(admin, email, businessName, input.redirectTo));

  // 5) Asegurar el profile (PK = ownerUserId) y la subscription. Idempotentes.
  await ensureProfile(admin, ownerUserId, shop.id, businessName);
  await ensureSubscription(admin, shop.id, input.provider, input.plan);

  return { shopId: shop.id, ownerUserId, created };
}

// --- Auth (GoTrue) -----------------------------------------------------------
// findAuthUserByEmail / isAlreadyRegistered viven en _shared/authAdmin.ts
// (compartidos con technician-access).

/**
 * Invita al dueño por email (magic link, sin contraseña inicial). Re-entrante:
 * si el usuario ya existía (corrida previa o webhook duplicado en carrera), GoTrue
 * responde "ya registrado" y recuperamos su id en vez de fallar.
 */
async function inviteOwner(
  admin: SupabaseClient,
  email: string,
  businessName: string,
  redirectTo?: string,
): Promise<string> {
  const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
    data: { business_name: businessName, full_name: businessName },
    ...(redirectTo ? { redirectTo } : {}),
  });
  if (!error && data?.user) return data.user.id;

  if (error && isAlreadyRegistered(error)) {
    const existing = await findAuthUserByEmail(admin, email);
    if (existing) return existing.id;
  }
  throw new Error(
    `inviteUserByEmail falló: ${error?.message ?? "no se devolvió usuario"}`,
  );
}

// --- Shops -------------------------------------------------------------------

/**
 * Crea el shop con slug único derivado del businessName. Maneja DOS posibles
 * violaciones de unique (23505), distinguidas POR NOMBRE de constraint (fijados
 * en 0011, no por el formato del mensaje de PostgREST):
 *
 *   - shops_slug_key (slug ya tomado): incrementa el sufijo y reintenta.
 *   - shops_contact_email_unique (otra corrida ya creó el taller para este email):
 *     NUNCA crea un segundo taller con slug -2. Vuelve a la BÚSQUEDA por
 *     contact_email y reusa ese taller ajeno (created=false).
 *
 * Devuelve `created=false` solo cuando descubre un taller ya existente por la
 * carrera de contact_email; `created=true` cuando el insert prospera.
 */
async function createShop(
  admin: SupabaseClient,
  businessName: string,
  email: string,
): Promise<{ id: string; created: boolean }> {
  const base = slugify(businessName);
  let n = 0;
  for (let tries = 0; tries < 50; tries++) {
    const slug = n === 0 ? base : `${base}-${n + 1}`;

    // Chequeo previo del slug: evita el insert si ya está tomado.
    const { data: taken, error: selErr } = await admin
      .from("shops")
      .select("id")
      .eq("slug", slug)
      .maybeSingle();
    if (selErr) throw new Error(`Lectura de slug falló: ${selErr.message}`);
    if (taken) {
      n++;
      continue;
    }

    const { data, error } = await admin
      .from("shops")
      .insert({
        name: businessName,
        slug,
        status: "active",
        contact_email: email,
        subscription_status: "active", // espejo denormalizado; la verdad está en subscriptions
        activated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (!error && data) return { id: data.id, created: true };

    if (error?.code === "23505") {
      // Carrera por contact_email: otra corrida ya creó el taller de este email.
      // No incrementamos el slug: hay que REUSAR ese taller ajeno, no duplicar.
      if (error.message?.includes("shops_contact_email_unique")) {
        const existing = await findShopByContactEmailAfterConflict(admin, email);
        return { id: existing.id, created: false };
      }
      // Colisión de slug (shops_slug_key): probar el siguiente sufijo.
      n++;
      continue;
    }

    throw new Error(`No se pudo crear el shop: ${error?.message ?? "desconocido"}`);
  }
  throw new Error(`No se pudo generar un slug único para "${businessName}"`);
}

/**
 * Tras un 23505 por shops_contact_email_unique sabemos que el taller de este email
 * EXISTE (otra transacción ya lo commiteó). Reintenta SOLO la lectura por
 * contact_email hasta verlo —defensa ante lag de réplica de lectura—, con backoff
 * acotado. Si se agota el límite, lanza error claro en vez de crear un duplicado.
 */
async function findShopByContactEmailAfterConflict(
  admin: SupabaseClient,
  email: string,
): Promise<{ id: string }> {
  for (let attempt = 0; attempt < CONTACT_EMAIL_READ_RETRIES; attempt++) {
    const existing = await findShopByContactEmail(admin, email);
    if (existing) return existing;
    await sleep(100 * (attempt + 1)); // backoff lineal: 100, 200, ... ms
  }
  throw new Error(
    `Conflicto de contact_email para ${email} (shops_contact_email_unique) pero el ` +
      `taller ajeno no resultó legible tras ${CONTACT_EMAIL_READ_RETRIES} intentos; ` +
      `se aborta para no crear un taller duplicado.`,
  );
}

async function getShopById(
  admin: SupabaseClient,
  id: string,
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from("shops")
    .select("id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Lectura de shop falló: ${error.message}`);
  return data;
}

async function findShopByContactEmail(
  admin: SupabaseClient,
  email: string,
): Promise<{ id: string } | null> {
  // contact_email es UNIQUE (0011): a lo sumo una fila. Mantenemos limit(1) por
  // robustez y para tolerar el breve estado previo a que la constraint exista.
  const { data, error } = await admin
    .from("shops")
    .select("id")
    .eq("contact_email", email)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw new Error(`Búsqueda de shop por email falló: ${error.message}`);
  return data?.[0] ?? null;
}

// --- Profiles ----------------------------------------------------------------

async function getProfileById(
  admin: SupabaseClient,
  id: string,
): Promise<{ id: string; shop_id: string | null; role: ProvisionRole } | null> {
  const { data, error } = await admin
    .from("profiles")
    .select("id, shop_id, role")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Lectura de profile falló: ${error.message}`);
  return data;
}

/**
 * Crea el profile que enlaza dueño <-> shop con rol shop_owner. Idempotente: si
 * ya existe y apunta al MISMO shop, no-op. Si existe y apunta a OTRO shop (o a
 * ninguno, p. ej. antawa_admin), lanza: no relinkeamos en silencio porque dejaría
 * un taller huérfano. (El flujo principal ya lo previene antes de crear; esto es
 * un backstop para cualquier caller futuro.) La PK = ownerUserId, así que una
 * carrera produce 23505 y la tratamos como "ya existe".
 */
async function ensureProfile(
  admin: SupabaseClient,
  ownerUserId: string,
  shopId: string,
  businessName: string,
): Promise<void> {
  const existing = await getProfileById(admin, ownerUserId);
  if (existing) {
    if (existing.shop_id !== shopId) {
      throw new Error(
        `El usuario ${ownerUserId} ya tiene un profile vinculado a ` +
          `${existing.shop_id ?? "ningún shop (antawa_admin)"}, distinto del shop ` +
          `${shopId} en provisioning. Se aborta para no dejar un taller huérfano.`,
      );
    }
    return; // ya enlazado al shop correcto -> idempotente
  }

  const { error } = await admin.from("profiles").insert({
    id: ownerUserId,
    shop_id: shopId,
    role: "shop_owner",
    full_name: businessName, // placeholder editable; el nombre real se captura en el onboarding
  });
  // 23505 = otra corrida lo insertó en paralelo -> idempotente.
  if (error && error.code !== "23505") {
    throw new Error(`No se pudo crear el profile: ${error.message}`);
  }
}

// --- Subscriptions -----------------------------------------------------------

/**
 * Crea la subscription del shop si falta. Comprueba antes de insertar y, además,
 * se apoya en la constraint subscriptions_shop_provider_unique (0011): si el
 * insert choca con un 23505 por esa constraint (carrera), lo trata como "ya
 * existe" (idempotente, igual que el 23505 del profile).
 */
async function ensureSubscription(
  admin: SupabaseClient,
  shopId: string,
  provider: ProvisionProvider,
  plan?: string,
): Promise<void> {
  const { data: existing, error: selErr } = await admin
    .from("subscriptions")
    .select("id")
    .eq("shop_id", shopId)
    .eq("provider", provider)
    .limit(1);
  if (selErr) throw new Error(`Lectura de subscription falló: ${selErr.message}`);
  if (existing && existing.length > 0) return;

  const currentPeriodEnd = new Date(Date.now() + THIRTY_DAYS_MS).toISOString();
  const { error } = await admin.from("subscriptions").insert({
    shop_id: shopId,
    provider,
    status: "active",
    plan: plan ?? null,
    current_period_end: currentPeriodEnd,
  });
  if (error) {
    if (
      error.code === "23505" &&
      error.message?.includes("subscriptions_shop_provider_unique")
    ) {
      return; // otra corrida la creó en paralelo -> idempotente
    }
    throw new Error(`No se pudo crear la subscription: ${error.message}`);
  }
}

// --- Utilidades --------------------------------------------------------------

function normalizeEmail(email: string): string {
  return (email ?? "").trim().toLowerCase();
}

/** Slug url-safe: sin acentos, minúsculas, separado por guiones, acotado. */
function slugify(input: string): string {
  const slug = input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita diacríticos (marcas combinantes)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/g, ""); // por si el slice cortó dentro de un guión
  return slug || "shop";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

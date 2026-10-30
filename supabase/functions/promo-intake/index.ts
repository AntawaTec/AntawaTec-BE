// =============================================================================
// promo-intake/index.ts
// Alta de un taller en PRUEBA GRATIS canjeando un código promocional (campaña
// "30 días gratis por código", 0047/0048). La invoca un PROSPECTO ANÓNIMO desde
// la landing (`antwt.com/prueba?codigo=XXXX`): no existe usuario todavía, así
// que no hay JWT posible (verify_jwt = false en config.toml). Es el gemelo de
// payphone-prepare / bank-transfer-intake, pero sin pago de por medio: el alta
// es INMEDIATA (provisionTenant con provider 'trial' + magic link).
//
// Contrato con la landing (CONGELADO — la landing muestra `error` TAL CUAL):
//   POST application/json { code, businessName, email, phone, website }
//     code          req, trim + upper, ^[A-Z0-9]{4,20}$
//     businessName  req (validateBusinessName de _shared/prospect.ts)
//     email         req (validateEmail; se normaliza trim + lower)
//     phone         req, trim, 7–20 chars de [0-9+ ()-]; se guarda tal cual
//     website       HONEYPOT: si viene lleno es un bot → 201 FALSO sin escribir
//   → 201 { shopId, email, periodEnd }
//   → 400 { error }  validación / "Este código no es válido o ya venció." /
//                    "Este código ya alcanzó su límite de usos."
//   → 409 { error: "Este email ya tiene un taller en AntawaTec. Ingresa en app.antwt.com." }
//   → 500 { error }
//
// Por qué 409 ante una cuenta existente: provisionTenant es idempotente por
// email, así que con un dueño que ya existe REUSARÍA su taller y le colgaría
// una segunda subscription 'trial' — una prueba gratis encima de un plan pago
// (o una segunda prueba). Una prueba por persona.
//
// Re-entrada (doble submit / red que se corta): el canje se inserta ANTES de
// provisionar y es único por (código, email). Si ya existe, es el mismo
// prospecto reintentando: se reusa la fila y se salta el tope de usos (ese cupo
// ya lo consumió él). Si además ya existe su usuario de auth, la corrida
// anterior llegó a invitarlo → 409 (el acceso ya le llegó; no hay email nuevo
// que mandar). Si no existe, provisionTenant completa lo que haya faltado.
//
// Defensa (sin captcha en V1): validación estricta in-code, honeypot, el código
// mismo (activo / no vencido / con cupo) y el unique por email. Las escrituras
// van con createAdminClient() (service_role); el service_role NUNCA sale.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  badRequest,
  created,
  json,
  methodNotAllowed,
  preflight,
  serverError,
} from "../_shared/response.ts";
import { validateBusinessName, validateEmail } from "../_shared/prospect.ts";
import { findAuthUserByEmail } from "../_shared/authAdmin.ts";
import { provisionTenant } from "../_shared/provisionTenant.ts";

const LABEL = "promo-intake";

const CODE_RE = /^[A-Z0-9]{4,20}$/;
// Sin normalizar a E.164 a propósito: el teléfono es para que Antawa contacte al
// dueño, no un destino de WhatsApp automático. Se guarda como lo escribió.
const PHONE_RE = /^[0-9+ ()-]{7,20}$/;

// Mensajes que la landing muestra tal cual (contrato congelado).
const MSG_INVALID_CODE = "Este código no es válido o ya venció.";
const MSG_CODE_EXHAUSTED = "Este código ya alcanzó su límite de usos.";
const MSG_ALREADY_HAS_SHOP =
  "Este email ya tiene un taller en AntawaTec. Ingresa en app.antwt.com.";
const MSG_PHONE = "phone es obligatorio (7–20 caracteres: dígitos, espacios, +, paréntesis o guiones).";
const MSG_GENERIC = "No pudimos activar tu prueba. Intenta de nuevo.";

interface RequestBody {
  code?: unknown;
  businessName?: unknown;
  email?: unknown;
  phone?: unknown;
  website?: unknown;
}

interface PromoCodeRow {
  code: string;
  trial_days: number;
  max_uses: number | null;
  expires_at: string | null;
  active: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError("Configuración del servidor incompleta.");
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }

  // 1) Honeypot ANTES de validar nada: al bot se le responde la misma forma que
  //    a un humano (shopId inventado), sin escribir ni delatar la detección.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    console.log(`${LABEL}: honeypot activado; 201 falso sin escritura.`);
    const fakeEmail = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    return created({ shopId: crypto.randomUUID(), email: fakeEmail });
  }

  // 2) Validación server-side (la landing valida lo mismo, pero acá manda).
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!CODE_RE.test(code)) return badRequest(MSG_INVALID_CODE);

  const businessNameCheck = validateBusinessName(body.businessName);
  if (!businessNameCheck.ok) return badRequest(businessNameCheck.message);
  const businessName = businessNameCheck.value;

  const emailCheck = validateEmail(body.email);
  if (!emailCheck.ok) return badRequest(emailCheck.message);
  const email = emailCheck.value;

  const phone = typeof body.phone === "string" ? body.phone.trim() : "";
  if (!PHONE_RE.test(phone)) return badRequest(MSG_PHONE);

  try {
    // 3) El código: existe, activo, no vencido.
    const promo = await loadPromoCode(admin, code);
    if (!promo || !promo.active || isExpired(promo.expires_at)) {
      console.log(`${LABEL}: código rechazado (${code}) para ${email}.`);
      return badRequest(MSG_INVALID_CODE);
    }

    // ¿Reintento del mismo prospecto? (ver cabecera: salta el tope de usos)
    let redemptionId = await findRedemptionId(admin, code, email);

    if (redemptionId && (await findAuthUserByEmail(admin, email))) {
      // El canje existe Y la cuenta ya se creó: la corrida anterior llegó hasta
      // la invitación (inviteOwner es el paso que crea el usuario), así que el
      // correo con el acceso YA salió. Volver a provisionar sería un no-op sin
      // email nuevo y la landing le diría "te enviamos el enlace" en falso. El
      // 409 lo manda a donde tiene que ir: a entrar con el enlace que ya tiene.
      console.log(`${LABEL}: ${email} reintenta un canje ya completado; 409.`);
      return json(409, { error: MSG_ALREADY_HAS_SHOP });
    }

    if (!redemptionId) {
      // 3.b) Tope de usos. Carrera aceptada: dos canjes simultáneos con el
      //      último cupo pueden pasar los dos (uno de más); para una campaña
      //      de marketing no vale un lock.
      if (promo.max_uses !== null) {
        const used = await countRedemptions(admin, code);
        if (used >= promo.max_uses) {
          console.log(`${LABEL}: código ${code} agotado (${used}/${promo.max_uses}).`);
          return badRequest(MSG_CODE_EXHAUSTED);
        }
      }

      // 4) ¿Ya tiene cuenta o taller? → 409 (una prueba por persona).
      if (await accountExists(admin, email)) {
        console.log(`${LABEL}: ${email} ya tiene cuenta/taller; 409.`);
        return json(409, { error: MSG_ALREADY_HAS_SHOP });
      }

      // 5) Canje PRIMERO (consume el cupo y es el ancla del reintento).
      redemptionId = await insertRedemption(admin, { code, email, businessName, phone });
    }

    // 6) Alta del taller. Re-entrante: si una corrida anterior murió a medias,
    //    completa sin duplicar (anclas de provisionTenant).
    const result = await provisionTenant(admin, {
      businessName,
      email,
      provider: "trial",
      plan: code,
      periodDays: promo.trial_days,
      contactPhone: phone,
      redirectTo: Deno.env.get("ONBOARDING_REDIRECT_URL") ?? undefined,
    });

    // 7) Enlazar el canje con el taller y devolver el vencimiento real.
    const { error: linkErr } = await admin
      .from("promo_redemptions")
      .update({ shop_id: result.shopId })
      .eq("id", redemptionId);
    if (linkErr) {
      // No bloquea al prospecto (su taller ya existe): el canje queda sin
      // shop_id y el admin lo cruza por email. Se loguea fuerte.
      console.error(
        `${LABEL}: no se pudo enlazar el canje ${redemptionId} al shop ` +
          `${result.shopId}: ${linkErr.message}`,
      );
    }

    const periodEnd = await loadTrialPeriodEnd(admin, result.shopId);

    console.log(
      `${LABEL}: prueba activa shop=${result.shopId} (${email}, código ${code}, ` +
        `${promo.trial_days} días, created=${result.created}).`,
    );
    return created({ shopId: result.shopId, email, periodEnd });
  } catch (e) {
    console.error(`${LABEL}: error activando la prueba de ${email}:`, e);
    return serverError(MSG_GENERIC);
  }
});

// --- Acceso a datos ----------------------------------------------------------

async function loadPromoCode(
  admin: SupabaseClient,
  code: string,
): Promise<PromoCodeRow | null> {
  const { data, error } = await admin
    .from("promo_codes")
    .select("code, trial_days, max_uses, expires_at, active")
    .eq("code", code)
    .maybeSingle();
  if (error) throw new Error(`Lectura del código falló: ${error.message}`);
  return (data as PromoCodeRow | null) ?? null;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return !Number.isNaN(t) && t < Date.now();
}

async function findRedemptionId(
  admin: SupabaseClient,
  code: string,
  email: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("promo_redemptions")
    .select("id")
    .eq("code", code)
    .eq("email", email)
    .maybeSingle();
  if (error) throw new Error(`Lectura del canje falló: ${error.message}`);
  return (data?.id as string | undefined) ?? null;
}

async function countRedemptions(admin: SupabaseClient, code: string): Promise<number> {
  const { count, error } = await admin
    .from("promo_redemptions")
    .select("id", { count: "exact", head: true })
    .eq("code", code);
  if (error) throw new Error(`Conteo de canjes falló: ${error.message}`);
  return count ?? 0;
}

/** Cuenta de auth con ese email, o taller cuyo contact_email es ese email. */
async function accountExists(admin: SupabaseClient, email: string): Promise<boolean> {
  if (await findAuthUserByEmail(admin, email)) return true;
  const { data, error } = await admin
    .from("shops")
    .select("id")
    .eq("contact_email", email)
    .limit(1);
  if (error) throw new Error(`Búsqueda de shop por email falló: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Inserta el canje. Un 23505 por promo_redemptions_code_email_unique es un
 * doble submit en carrera con esta misma llamada: se relee y se reusa la fila.
 */
async function insertRedemption(
  admin: SupabaseClient,
  r: { code: string; email: string; businessName: string; phone: string },
): Promise<string> {
  const { data, error } = await admin
    .from("promo_redemptions")
    .insert({
      code: r.code,
      email: r.email,
      business_name: r.businessName,
      phone: r.phone,
    })
    .select("id")
    .single();
  if (!error && data) return data.id as string;

  if (
    error?.code === "23505" &&
    error.message?.includes("promo_redemptions_code_email_unique")
  ) {
    const existing = await findRedemptionId(admin, r.code, r.email);
    if (existing) return existing;
  }
  throw new Error(`Insert del canje falló: ${error?.message ?? "sin fila"}`);
}

async function loadTrialPeriodEnd(
  admin: SupabaseClient,
  shopId: string,
): Promise<string | null> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("current_period_end")
    .eq("shop_id", shopId)
    .eq("provider", "trial")
    .maybeSingle();
  if (error) throw new Error(`Lectura de la subscription falló: ${error.message}`);
  return (data?.current_period_end as string | null | undefined) ?? null;
}

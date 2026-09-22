// =============================================================================
// payphone-prepare/index.ts
// Primer paso del pago con TARJETA desde la landing. La invoca un PROSPECTO
// ANÓNIMO: no existe usuario todavía, así que no hay JWT posible
// (verify_jwt = false en config.toml). Es el gemelo de bank-transfer-intake para
// el embudo de tarjeta; la segunda mitad es payphone-confirm.
//
// Contrato con la landing (CONGELADO — no cambiar nombres ni códigos):
//   POST application/json { businessName, email, website }
//     businessName  req, 1–120 chars   (validado en _shared/prospect.ts)
//     email         req, ≤254 + regex  (validado en _shared/prospect.ts)
//     website       HONEYPOT: si viene lleno es un bot → 201 FALSO sin escribir
//   → 201 { intentId, payWithCard }   payWithCard = URL de Payphone a la que
//                                     la landing redirige con location.assign
//   → 400 | 429 | 500 { error }
//
// Qué hace: guarda el intento en card_payment_intents (0037) —hay que persistir
// taller y email ANTES de redirigir, porque el retorno de Payphone no los trae—
// y pide el link de pago con `clientTransactionId = intent.id`. Todavía NO hay
// cobro: eso pasa en payphone-confirm.
//
// Defensa (sin captcha en V1): validación estricta in-code, honeypot y cap de 5
// intents 'created' por email en la última hora (429). Las escrituras van con
// createAdminClient() (service_role, salta el RLS sin políticas de
// card_payment_intents); el service_role y el PAYPHONE_TOKEN NUNCA salen de la
// función.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  badRequest,
  created,
  methodNotAllowed,
  preflight,
  serverError,
  tooManyRequests,
} from "../_shared/response.ts";
import { validateBusinessName, validateEmail } from "../_shared/prospect.ts";
import { type PayphoneEnv, payphoneEnv, preparePayment, PRICE_USD } from "../_shared/payphone.ts";

/** Cap anti-abuso: a partir del 6º intent 'created' del mismo email en 1 h → 429. */
const MAX_CREATED_PER_EMAIL = 5;
const CAP_WINDOW_MS = 60 * 60 * 1000;

/** Payphone acota el texto que muestra en el formulario de pago. */
const MAX_REFERENCE = 60;

interface RequestBody {
  businessName?: unknown;
  email?: unknown;
  website?: unknown;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  // Config completa ANTES de tocar nada: si falta un secreto, 500 sin escribir.
  let admin: SupabaseClient;
  let env: PayphoneEnv;
  try {
    admin = createAdminClient();
    env = payphoneEnv();
  } catch (e) {
    console.error("payphone-prepare: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }

  // Honeypot ANTES de validar nada: a un bot que llenó el campo oculto se le
  // responde el mismo 201 que a un humano (intentId inventado y la URL de
  // cancelación como destino), sin escribir ni delatar que fue detectado.
  if (typeof body.website === "string" && body.website.trim() !== "") {
    console.log("payphone-prepare: honeypot activado; 201 falso sin escritura.");
    return created({ intentId: crypto.randomUUID(), payWithCard: env.cancellationUrl });
  }

  // --- Validación server-side (la landing valida lo mismo, pero acá manda) ---
  const businessNameCheck = validateBusinessName(body.businessName);
  if (!businessNameCheck.ok) return badRequest(businessNameCheck.message);
  const businessName = businessNameCheck.value;

  const emailCheck = validateEmail(body.email);
  if (!emailCheck.ok) return badRequest(emailCheck.message);
  const email = emailCheck.value;

  let intentId: string | null = null;
  try {
    // Cap anti-abuso por email en ventana móvil de 1 hora.
    const since = new Date(Date.now() - CAP_WINDOW_MS).toISOString();
    const { count, error: countErr } = await admin
      .from("card_payment_intents")
      .select("id", { count: "exact", head: true })
      .eq("email", email)
      .eq("status", "created")
      .gte("created_at", since);
    if (countErr) throw new Error(`Conteo de intents falló: ${countErr.message}`);
    if ((count ?? 0) >= MAX_CREATED_PER_EMAIL) {
      return tooManyRequests(
        "Ya hay varios intentos de pago abiertos para este email. Espera unos minutos.",
      );
    }

    // La fila PRIMERO: su id es el clientTransactionId que viaja a Payphone y con
    // el que volverá el usuario. Sin fila no habría a quién provisionar al volver.
    const { data: intent, error: insErr } = await admin
      .from("card_payment_intents")
      .insert({
        business_name: businessName,
        email,
        amount: PRICE_USD,
        // provider y status usan los DEFAULT de 0037 ('payphone' / 'created').
      })
      .select("id")
      .single();
    if (insErr || !intent) {
      throw new Error(`Insert del intent falló: ${insErr?.message ?? "sin fila"}`);
    }
    intentId = intent.id as string;

    // Link de pago. Si Payphone falla, el intent queda 'failed' (no se reusa) y el
    // usuario reintenta desde cero con un intent nuevo.
    let prepared;
    try {
      prepared = await preparePayment({
        clientTransactionId: intentId,
        email,
        reference: `AntawaTec · ${businessName}`.slice(0, MAX_REFERENCE),
      });
    } catch (e) {
      console.error(`payphone-prepare: Prepare falló para el intent ${intentId}:`, e);
      await markFailed(admin, intentId);
      return serverError("No pudimos iniciar el pago. Intenta de nuevo.");
    }

    // paymentId es solo auditoría (el Confirm usa el `id` del retorno), así que un
    // fallo acá NO debe impedirle pagar: se loguea y se sigue.
    const { error: updErr } = await admin
      .from("card_payment_intents")
      .update({ payphone_payment_id: prepared.paymentId })
      .eq("id", intentId);
    if (updErr) {
      console.error(
        `payphone-prepare: no se pudo guardar payphone_payment_id del intent ` +
          `${intentId}: ${updErr.message}`,
      );
    }

    console.log(`payphone-prepare: intent ${intentId} listo para pagar (${email}).`);
    return created({ intentId, payWithCard: prepared.payWithCard });
  } catch (e) {
    console.error(`payphone-prepare: error creando el intent ${intentId ?? "-"}:`, e);
    return serverError("No pudimos iniciar el pago. Intenta de nuevo.");
  }
});

/** Best-effort: marcar el intent como fallido no debe tapar el error original. */
async function markFailed(admin: SupabaseClient, intentId: string): Promise<void> {
  const { error } = await admin
    .from("card_payment_intents")
    .update({ status: "failed" })
    .eq("id", intentId);
  if (error) {
    console.error(
      `payphone-prepare: no se pudo marcar 'failed' el intent ${intentId}: ${error.message}`,
    );
  }
}

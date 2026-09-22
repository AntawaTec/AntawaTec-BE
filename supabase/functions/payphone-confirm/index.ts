// =============================================================================
// payphone-confirm/index.ts
// Segundo paso del pago con TARJETA. La invoca la landing cuando Payphone
// devuelve al usuario a `responseUrl?id=<int>&clientTransactionId=<uuid>`. Como
// payphone-prepare, la llama un PROSPECTO ANÓNIMO (verify_jwt = false); la
// defensa es que el `clientTransactionId` es un uuid v4 impredecible y que TODO
// lo que decide el resultado viene del Confirm server-side de Payphone, no del
// cliente.
//
// Contrato con la landing (CONGELADO — no cambiar nombres ni códigos):
//   POST application/json { id: number, clientTransactionId: string }
//   → 200 { status: "approved", email }   pago cobrado y taller provisionado
//   → 200 { status: "cancelled" }         el usuario abandonó el pago
//   → 409 { error }                       otra invocación lo está confirmando;
//                                         la landing REINTENTA a los pocos segundos
//   → 400 | 404 | 500 { error }
//
// ORDEN QUE NO SE PUEDE ALTERAR (el Confirm de Payphone NO es idempotente y
// reversa el cobro si no se llama en < 5 min):
//   1. lock optimista atómico (RPC acquire_card_payment_intent, 0037) para que
//      exactamente UNA invocación llame al Confirm.
//   2. Confirm -> si aprueba, PERSISTIR 'confirmed' ANTES de provisionar. A
//      partir de ahí el cobro es real y ningún fallo puede perderlo: el
//      reintento salta el Confirm y solo reintenta el provisioning.
//   3. provisionTenant (idempotente/re-entrante) + ledger en webhook_events.
//   4. 'approved' + shop_id.
//
// Simetría con el resto del embudo: se provisiona con la MISMA llamada que
// hotmart-webhook y bank-transfer-approval. Como bank-transfer-approval, NO se
// reactiva el shop tras provisionar (solo hotmart-webhook lo hace, por el ciclo
// refund -> recompra que la tarjeta no tiene hoy).
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  badRequest,
  json,
  methodNotAllowed,
  notFound,
  ok,
  preflight,
  serverError,
} from "../_shared/response.ts";
import { provisionTenant } from "../_shared/provisionTenant.ts";
import {
  confirmPayment,
  type PayphoneConfirmResponse,
  payphoneEnv,
  PRICE_CENTS,
} from "../_shared/payphone.ts";

const PROVIDER = "payphone" as const;
const EVENT_TYPE = "confirm.approved";

/** statusCode del Confirm: 3 = Approved, 2 = Canceled. */
const STATUS_APPROVED = 3;
const STATUS_CANCELED = 2;

/** Un 'confirming' más viejo que esto se considera abandonado y se re-adquiere. */
const STALE_LOCK_SECONDS = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type IntentStatus =
  | "created"
  | "confirming"
  | "confirmed"
  | "approved"
  | "cancelled"
  | "failed";

interface RequestBody {
  id?: unknown;
  clientTransactionId?: unknown;
}

interface IntentRow {
  id: string;
  business_name: string;
  email: string;
  status: IntentStatus;
  payphone_transaction_id: number | null;
  authorization_code: string | null;
  shop_id: string | null;
  confirmed_at: string | null;
}

/** Fila que devuelve la RPC acquire_card_payment_intent (0037). */
interface AcquiredIntent {
  id: string;
  previous_status: IntentStatus;
  business_name: string;
  email: string;
  amount: number;
  payphone_payment_id: string | null;
  payphone_transaction_id: number | null;
  authorization_code: string | null;
  shop_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
    payphoneEnv(); // falla temprano si falta un secreto de Payphone
  } catch (e) {
    console.error("payphone-confirm: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  // --- 1) Body y validación -------------------------------------------------
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Body inválido: se esperaba JSON.");
  }

  const payphoneId = body.id;
  if (
    typeof payphoneId !== "number" || !Number.isSafeInteger(payphoneId) ||
    payphoneId <= 0
  ) {
    return badRequest("id es obligatorio y debe ser un entero positivo.");
  }

  const clientTransactionId = typeof body.clientTransactionId === "string"
    ? body.clientTransactionId.trim()
    : "";
  if (!UUID_RE.test(clientTransactionId)) {
    return badRequest("clientTransactionId es obligatorio y debe ser un uuid.");
  }

  try {
    // --- 2) Cargar el intent ------------------------------------------------
    const intent = await loadIntent(admin, clientTransactionId);
    if (!intent) return notFound("No encontramos ese intento de pago.");

    // Atajos idempotentes (recarga de la página de retorno, doble clic): no hace
    // falta ni tomar el lock ni llamar a Payphone.
    if (intent.status === "approved") {
      return ok({ status: "approved", email: intent.email });
    }
    if (intent.status === "cancelled") {
      return ok({ status: "cancelled" });
    }

    // --- 3) Lock optimista atómico -----------------------------------------
    const { data: acquiredRows, error: lockErr } = await admin.rpc(
      "acquire_card_payment_intent",
      { p_id: clientTransactionId, p_stale_seconds: STALE_LOCK_SECONDS },
    );
    if (lockErr) throw new Error(`Lock del intent falló: ${lockErr.message}`);

    const acquired = (acquiredRows as AcquiredIntent[] | null)?.[0] ?? null;
    if (!acquired) {
      // No se pudo adquirir: alguien más lo tiene o ya es terminal. Releer y
      // responder por el estado actual.
      const current = await loadIntent(admin, clientTransactionId);
      if (!current) return notFound("No encontramos ese intento de pago.");
      switch (current.status) {
        case "approved":
          return ok({ status: "approved", email: current.email });
        case "cancelled":
          return ok({ status: "cancelled" });
        case "failed":
          console.error(
            `payphone-confirm: intent ${clientTransactionId} está en 'failed'; ` +
              `requiere revisión manual.`,
          );
          return serverError("No pudimos confirmar tu pago. Escríbenos para ayudarte.");
        default:
          // 'confirming' (otra invocación en curso) o una carrera que lo soltó
          // justo ahora: 409 y la landing reintenta.
          return json(409, {
            error: "Estamos confirmando tu pago, espera unos segundos.",
          });
      }
    }

    // --- 4) Confirmar con Payphone (solo si el cobro no está hecho) ---------
    // La decisión se toma sobre el DATO PERSISTIDO, no sobre el estado: si
    // `payphone_transaction_id` ya tiene valor, una corrida anterior YA recibió
    // respuesta del Confirm y el cobro está hecho —aunque haya muerto antes de
    // dejar el estado en 'confirmed'—. El Confirm NO es idempotente, así que
    // llamarlo por segunda vez sobre un pago aprobado es exactamente lo que hay
    // que evitar; el estado por sí solo no alcanza para descartarlo.
    //   transactionId == null  -> venía de 'created', o de un 'confirming'
    //                             abandonado que nunca llegó a persistir nada:
    //                             hay que llamar al Confirm (perder el cobro es
    //                             peor que reintentarlo).
    //   transactionId != null  -> 'confirmed', o 'confirming' abandonado que ya
    //                             había persistido el resultado: se salta el
    //                             Confirm y se va directo a provisionar.
    let transactionId = acquired.payphone_transaction_id ?? null;
    const needsConfirm = transactionId === null;

    if (needsConfirm) {
      if (acquired.previous_status === "confirming") {
        console.warn(
          `payphone-confirm: se re-adquirió el lock abandonado del intent ` +
            `${clientTransactionId} SIN transactionId persistido; se reintenta el Confirm.`,
        );
      }

      let confirmed: PayphoneConfirmResponse;
      try {
        confirmed = await confirmPayment({
          id: payphoneId,
          clientTxId: clientTransactionId,
        });
      } catch (e) {
        // Fallo de red / error del proveedor: NO sabemos el resultado. Se
        // devuelve a 'created' para que el usuario reintente dentro de los 5 min.
        console.error(
          `payphone-confirm: Confirm falló para el intent ${clientTransactionId} ` +
            `(payphoneId=${payphoneId}):`,
          e,
        );
        await setStatus(admin, clientTransactionId, "created");
        return serverError("No pudimos confirmar tu pago. Intenta de nuevo.");
      }

      // Sanity: la transacción confirmada tiene que ser LA NUESTRA.
      if (
        typeof confirmed.clientTransactionId === "string" &&
        confirmed.clientTransactionId !== clientTransactionId
      ) {
        console.error(
          `payphone-confirm: el Confirm devolvió clientTransactionId=` +
            `"${confirmed.clientTransactionId}" para el intent ${clientTransactionId}. ` +
            `Se marca 'failed' para revisión manual.`,
        );
        await setStatus(admin, clientTransactionId, "failed");
        return serverError("No pudimos confirmar tu pago. Escríbenos para ayudarte.");
      }

      if (confirmed.statusCode === STATUS_CANCELED) {
        const { error } = await admin
          .from("card_payment_intents")
          .update({
            status: "cancelled",
            payphone_transaction_id: confirmed.transactionId ?? null,
          })
          .eq("id", clientTransactionId);
        if (error) throw new Error(`No se pudo marcar 'cancelled': ${error.message}`);
        console.log(
          `payphone-confirm: intent ${clientTransactionId} CANCELADO por el usuario.`,
        );
        return ok({ status: "cancelled" });
      }

      if (confirmed.statusCode !== STATUS_APPROVED) {
        console.error(
          `payphone-confirm: statusCode inesperado (${confirmed.statusCode}) para el ` +
            `intent ${clientTransactionId}. Se marca 'failed' para revisión manual.`,
        );
        await setStatus(admin, clientTransactionId, "failed");
        return serverError("No pudimos confirmar tu pago. Escríbenos para ayudarte.");
      }

      // Aprobada: recién acá el monto importa (con statusCode 2 no hubo cobro).
      // Solo un monto REALMENTE distinto marca 'failed'. Si Payphone no devuelve
      // `amount` (o no es numérico) NO se castiga al usuario: el
      // clientTransactionId ya coincidió y el Prepare que armamos era por
      // PRICE_CENTS, así que se loguea y se sigue.
      if (typeof confirmed.amount !== "number") {
        console.warn(
          `payphone-confirm: el Confirm del intent ${clientTransactionId} no trajo un ` +
            `\`amount\` numérico (${JSON.stringify(confirmed.amount)}); se continúa ` +
            `porque el clientTransactionId coincide y el Prepare fue por ${PRICE_CENTS}.`,
        );
      } else if (confirmed.amount !== PRICE_CENTS) {
        console.error(
          `payphone-confirm: monto inesperado en el intent ${clientTransactionId}: ` +
            `Payphone devolvió ${confirmed.amount}, se esperaba ${PRICE_CENTS}. ` +
            `Se marca 'failed' para revisión manual.`,
        );
        await setStatus(admin, clientTransactionId, "failed");
        return serverError("No pudimos confirmar tu pago. Escríbenos para ayudarte.");
      }

      // EL COBRO YA ES REAL. Persistirlo ANTES de provisionar: de acá en más un
      // fallo solo cuesta un reintento, nunca el pago.
      transactionId = confirmed.transactionId ?? null;
      const { error: confErr } = await admin
        .from("card_payment_intents")
        .update({
          status: "confirmed",
          payphone_transaction_id: transactionId,
          authorization_code: confirmed.authorizationCode ?? null,
          confirmed_at: new Date().toISOString(),
        })
        .eq("id", clientTransactionId);
      if (confErr) {
        throw new Error(`No se pudo marcar 'confirmed': ${confErr.message}`);
      }
      console.log(
        `payphone-confirm: intent ${clientTransactionId} COBRADO ` +
          `(transactionId=${transactionId}).`,
      );

      // Ledger de auditoría con el payload crudo, ANTES de provisionar: si el
      // provisioning falla, la respuesta de Payphone no se pierde.
      await recordConfirmEvent(
        admin,
        externalIdFor(transactionId, clientTransactionId),
        confirmed,
      );
    } else {
      // Reintento con el cobro YA hecho: el ledger se escribió en la corrida que
      // cobró. Este insert es un backstop por si aquella murió justo antes.
      // El try/catch NO es decorativo: acá el intent está en 'confirming' (lo
      // acabamos de lockear) y si esto explota sin soltar el lock, la fila queda
      // trabada 60 s y el reintento posterior podría re-disparar un Confirm.
      try {
        await recordConfirmEvent(
          admin,
          externalIdFor(transactionId, clientTransactionId),
          {
            note: "reconstruido en un reintento del provisioning (sin respuesta cruda)",
            intentId: clientTransactionId,
            transactionId,
            authorizationCode: acquired.authorization_code,
          },
        );
      } catch (e) {
        console.error(
          `payphone-confirm: no se pudo registrar el ledger del intent ` +
            `${clientTransactionId} en el reintento (cobro YA realizado, ` +
            `transactionId=${transactionId}):`,
          e,
        );
        await setStatus(admin, clientTransactionId, "confirmed");
        return serverError(
          "Tu pago se registró, pero no pudimos activar tu taller. Intenta de nuevo.",
        );
      }
    }

    // --- 5) Provisioning (idempotente) + cierre -----------------------------
    let shopId: string;
    try {
      const result = await provisionTenant(admin, {
        businessName: acquired.business_name,
        email: acquired.email,
        provider: PROVIDER,
        redirectTo: Deno.env.get("ONBOARDING_REDIRECT_URL") || undefined,
      });
      shopId = result.shopId;
      console.log(
        `payphone-confirm: intent ${clientTransactionId} provisionado. ` +
          `shop=${shopId} created=${result.created}`,
      );
    } catch (e) {
      // El cobro está hecho: se libera el lock DEJANDO el intent en 'confirmed'
      // para que el reintento de la landing salte el Confirm y solo reintente
      // el provisioning.
      console.error(
        `payphone-confirm: provisioning falló para el intent ${clientTransactionId} ` +
          `(cobro YA realizado, transactionId=${transactionId}):`,
        e,
      );
      await setStatus(admin, clientTransactionId, "confirmed");
      return serverError(
        "Tu pago se registró, pero no pudimos activar tu taller. Intenta de nuevo.",
      );
    }

    await markConfirmEventProcessed(
      admin,
      externalIdFor(transactionId, clientTransactionId),
      shopId,
    );

    const { error: apprErr } = await admin
      .from("card_payment_intents")
      .update({ status: "approved", shop_id: shopId })
      .eq("id", clientTransactionId);
    if (apprErr) {
      // El taller ya existe y el pago está cobrado; solo quedó el estado atrás.
      // Hay que DEVOLVER el intent a 'confirmed': si se quedara en 'confirming'
      // (que es como está ahora, con el lock tomado), el reintento chocaría 60 s
      // con un 409 y recién después entraría por el camino del cobro ya hecho.
      // Con 'confirmed', el reintento re-provisiona (idempotente) y cierra.
      console.error(
        `payphone-confirm: no se pudo marcar 'approved' el intent ` +
          `${clientTransactionId} (shop=${shopId} YA provisionado): ${apprErr.message}`,
      );
      await setStatus(admin, clientTransactionId, "confirmed");
      return serverError(
        "Tu pago se registró, pero no pudimos activar tu taller. Intenta de nuevo.",
      );
    }

    return ok({ status: "approved", email: acquired.email });
  } catch (e) {
    console.error(
      `payphone-confirm: error procesando el intent ${clientTransactionId}:`,
      e,
    );
    return serverError("No pudimos confirmar tu pago. Intenta de nuevo.");
  }
});

// --- Helpers -----------------------------------------------------------------

async function loadIntent(
  admin: SupabaseClient,
  id: string,
): Promise<IntentRow | null> {
  const { data, error } = await admin
    .from("card_payment_intents")
    .select(
      "id, business_name, email, status, payphone_transaction_id, authorization_code, shop_id, confirmed_at",
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`Lectura del intent falló: ${error.message}`);
  return (data as IntentRow | null) ?? null;
}

/** Cambio de estado simple (soltar el lock, marcar 'failed'). Best-effort logueado. */
async function setStatus(
  admin: SupabaseClient,
  id: string,
  status: IntentStatus,
): Promise<void> {
  const { error } = await admin
    .from("card_payment_intents")
    .update({ status })
    .eq("id", id);
  if (error) {
    console.error(
      `payphone-confirm: no se pudo dejar el intent ${id} en '${status}': ${error.message}`,
    );
  }
}

/**
 * external_id del ledger: el transactionId de Payphone cuando existe. Fallback al
 * uuid del intent porque `unique(provider, external_id)` NO deduplica NULLs
 * (mismo razonamiento que el hash de payload en hotmart-webhook).
 */
function externalIdFor(
  transactionId: number | null,
  intentId: string,
): string {
  return transactionId === null || transactionId === undefined
    ? intentId
    : String(transactionId);
}

/**
 * Insert-first en webhook_events con el payload del Confirm. Idempotente: un
 * 23505 (provider, external_id) significa que una corrida previa ya lo registró.
 */
async function recordConfirmEvent(
  admin: SupabaseClient,
  externalId: string,
  payload: unknown,
): Promise<void> {
  const { error } = await admin.from("webhook_events").insert({
    provider: PROVIDER,
    event_type: EVENT_TYPE,
    external_id: externalId,
    payload,
    processed: false,
  });
  if (error && error.code !== "23505") {
    throw new Error(`No se pudo registrar el webhook_event: ${error.message}`);
  }
}

/** Cierra el ledger: procesado + shop enlazado. No es crítico: se loguea y sigue. */
async function markConfirmEventProcessed(
  admin: SupabaseClient,
  externalId: string,
  shopId: string,
): Promise<void> {
  const { error } = await admin
    .from("webhook_events")
    .update({ processed: true, shop_id: shopId })
    .eq("provider", PROVIDER)
    .eq("external_id", externalId);
  if (error) {
    console.error(
      `payphone-confirm: no se pudo marcar procesado el webhook_event ` +
        `${externalId}: ${error.message}`,
    );
  }
}

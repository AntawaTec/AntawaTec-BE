// =============================================================================
// subscription-renewal-approval/index.ts
// Aprobación / rechazo de una RENOVACIÓN mensual pagada por transferencia. La
// invoca el admin de Antawa desde el dashboard (navegador), igual que
// `bank-transfer-approval` — pero esa da de ALTA un taller (provisioning) y esta
// EXTIENDE la suscripción de uno que ya existe. Por eso son dos funciones y no
// un `if` adentro de una: el alta crea usuario, shop, profile y manda magic
// link; la renovación solo mueve fechas. Mezclarlas obligaría a que cada retry
// del alta pase por la aritmética de períodos, y viceversa.
//
// Seguridad: `verify_jwt = false` en config.toml para que el preflight OPTIONS
// (que el navegador manda SIN Authorization) no muera con 401. La auth real —
// JWT contra GoTrue + rol antawa_admin leído de `profiles` — va DENTRO, en
// `requireAntawaAdmin`. Las escrituras usan el cliente service_role; el JWT del
// caller solo sirve para identificarlo y firmar `validated_by`.
//
// Por qué Edge Function y no una RPC `security definer` (lección 0037): una RPC
// nueva en `public` nace con EXECUTE para anon y authenticated por los default
// privileges de Supabase y hay que revocarlo a mano; acá el borde ya es el
// gateway + la verificación de rol, y no queda superficie SQL invocable.
//
// IDEMPOTENCIA (el punto delicado): aprobar dos veces NUNCA puede sumar dos
// meses. El ancla es `bank_transfer_proofs.period_end`, que se escribe en el
// MISMO UPDATE condicional que marca el proof como aprobado
// (`where status = 'pending'` → gana una sola llamada). Todo lo que viene
// después se calcula a partir de ese valor GUARDADO, no de `now()`, y se
// escribe con el instante ABSOLUTO (nunca `+ interval` en SQL). Un reintento
// tras un fallo parcial converge al mismo estado final.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  badRequest,
  methodNotAllowed,
  notFound,
  ok,
  preflight,
  serverError,
} from "../_shared/response.ts";
import { requireAntawaAdmin } from "../_shared/requireAdmin.ts";
import {
  computeRenewalPeriod,
  maxDate,
  parseTimestamp,
} from "../_shared/subscriptionPeriod.ts";

const LABEL = "subscription-renewal-approval";
const PROVIDER = "bank_transfer" as const;
const DEFAULT_PLAN = "mensual";

type Decision = "approve" | "reject";

interface RequestBody {
  proofId?: string;
  decision?: Decision;
}

interface ProofRow {
  id: string;
  kind: string;
  shop_id: string | null;
  status: string;
  period_end: string | null;
}

interface SubscriptionRow {
  id: string;
  current_period_end: string | null;
}

Deno.serve(async (req) => {
  // 1) Preflight CORS: responder ANTES de exigir auth.
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError("Configuración del servidor incompleta.");
  }

  // 2) Identidad + autorización del caller (antawa_admin).
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
  const proofId = typeof body.proofId === "string" ? body.proofId.trim() : "";
  const decision = body.decision;
  if (!proofId) return badRequest("Falta proofId.");
  if (decision !== "approve" && decision !== "reject") {
    return badRequest("decision debe ser 'approve' o 'reject'.");
  }

  try {
    // 4) Cargar el comprobante y validar que sea una RENOVACIÓN.
    const proof = await loadProof(admin, proofId);
    if (!proof) return notFound("No existe el comprobante de transferencia.");
    if (proof.kind !== "renewal") {
      // Un 'signup' se aprueba con bank-transfer-approval (provisiona el taller).
      // Aprobarlo acá dejaría al prospecto sin usuario ni magic link.
      return badRequest(
        "Este comprobante es de alta, no de renovación: usá bank-transfer-approval.",
      );
    }
    // Garantizado por btp_renewal_requires_shop_ck (0042). Si pasa, alguien
    // tocó la fila con service_role saltándose la constraint: no adivinamos.
    if (!proof.shop_id) {
      console.error(`${LABEL}: proof ${proofId} es renewal pero no tiene shop_id.`);
      return serverError("El comprobante de renovación no tiene taller asociado.");
    }
    const shopId = proof.shop_id;

    // 5) Rechazo: marcar rejected, sin tocar la suscripción.
    if (decision === "reject") {
      const rejected = await markRejected(admin, proofId, callerId);
      if (!rejected) {
        // Perdimos la carrera (o ya estaba resuelto): devolver el estado real.
        const current = await loadProof(admin, proofId);
        console.log(
          `${LABEL}: proof ${proofId} ya estaba procesado (${current?.status}).`,
        );
        return ok({
          status: current?.status ?? proof.status,
          shopId,
          alreadyProcessed: true,
        });
      }
      console.log(`${LABEL}: proof ${proofId} RECHAZADO por admin ${callerId}.`);
      return ok({ status: "rejected", shopId });
    }

    // ===== 6) Aprobación =====================================================

    // 6.a) Suscripción vigente del taller: la de vencimiento más lejano. Se
    //      EXTIENDE esa (no se crea una por proveedor): "hasta cuándo pagó el
    //      taller" es un hecho del taller, y dos filas activas con fechas
    //      distintas serían dos verdades. Caso raro y consciente: un taller que
    //      venía de Hotmart y pasa a transferencia renueva la fila de Hotmart;
    //      preferible a dejarlo con dos suscripciones vivas.
    const sub = await loadLatestSubscription(admin, shopId);
    const subEnd = parseTimestamp(sub?.current_period_end);

    // 6.b) Período que paga este comprobante.
    const now = new Date();
    const period = computeRenewalPeriod(subEnd, now);

    // 6.c) LOCK: el UPDATE condicional por status='pending' es el que decide
    //      quién gana. Escribe el período JUNTO con la aprobación para que un
    //      reintento lo reuse en vez de recalcularlo.
    const locked = await lockApproval(admin, proofId, callerId, period);

    let periodEnd: Date;
    let alreadyProcessed = false;

    if (locked) {
      periodEnd = parseTimestamp(locked.period_end) ?? period.end;
    } else {
      // 0 filas: otra llamada se adelantó (doble clic, retry). Releer y
      // CONVERGER con lo que quedó guardado — nunca recalcular un mes nuevo.
      const current = await loadProof(admin, proofId);
      alreadyProcessed = true;

      if (!current || current.status !== "approved") {
        console.log(
          `${LABEL}: proof ${proofId} no se pudo aprobar; estado actual = ${current?.status}.`,
        );
        return ok({
          status: current?.status ?? proof.status,
          shopId,
          alreadyProcessed: true,
        });
      }

      const storedEnd = parseTimestamp(current.period_end);
      if (!storedEnd) {
        // Imposible por el camino de esta función (period_end se escribe en el
        // mismo UPDATE que el approved). Si pasa, hubo edición manual: no
        // inventamos una fecha, se avisa fuerte.
        console.error(
          `${LABEL}: proof ${proofId} está approved SIN period_end. Revisar a mano.`,
        );
        return serverError(
          "El comprobante figura aprobado pero sin período: revisalo a mano.",
        );
      }
      periodEnd = storedEnd;
    }

    // 6.d) Suscripción: escribir el vencimiento ABSOLUTO y que nunca retroceda.
    await applySubscription(admin, shopId, sub, periodEnd);

    // 6.e) Espejo en el taller (lo mismo que hace reactivate() en hotmart-webhook).
    await activateShop(admin, shopId);

    console.log(
      `${LABEL}: proof ${proofId} APROBADO por admin ${callerId}. ` +
        `shop=${shopId} periodEnd=${periodEnd.toISOString()}` +
        (alreadyProcessed ? " (convergencia de un reintento)" : ""),
    );
    return ok({
      status: "approved",
      shopId,
      periodEnd: periodEnd.toISOString(),
      ...(alreadyProcessed ? { alreadyProcessed: true } : {}),
    });
  } catch (e) {
    // Error real (DB) -> 500. Lo ya escrito es convergente: un retry termina.
    console.error(`${LABEL}: error procesando proof ${proofId}:`, e);
    return serverError("Error procesando la renovación.");
  }
});

// --- Acceso a datos ----------------------------------------------------------

async function loadProof(
  admin: SupabaseClient,
  proofId: string,
): Promise<ProofRow | null> {
  const { data, error } = await admin
    .from("bank_transfer_proofs")
    .select("id, kind, shop_id, status, period_end")
    .eq("id", proofId)
    .maybeSingle();
  if (error) throw new Error(`Lectura del proof falló: ${error.message}`);
  return (data as ProofRow | null) ?? null;
}

/** La suscripción de vencimiento más lejano del taller (nulls al final). */
async function loadLatestSubscription(
  admin: SupabaseClient,
  shopId: string,
): Promise<SubscriptionRow | null> {
  const { data, error } = await admin
    .from("subscriptions")
    .select("id, current_period_end")
    .eq("shop_id", shopId)
    .order("current_period_end", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Lectura de subscription falló: ${error.message}`);
  return (data as SubscriptionRow | null) ?? null;
}

/** Rechazo condicional. false = ya no estaba pending. */
async function markRejected(
  admin: SupabaseClient,
  proofId: string,
  callerId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("bank_transfer_proofs")
    .update({
      status: "rejected",
      validated_by: callerId,
      validated_at: new Date().toISOString(),
    })
    .eq("id", proofId)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();
  if (error) throw new Error(`No se pudo rechazar el proof: ${error.message}`);
  return data !== null;
}

/**
 * Aprobación condicional (el lock). Devuelve la fila si ESTA llamada ganó, o
 * null si el proof ya no estaba pending.
 */
async function lockApproval(
  admin: SupabaseClient,
  proofId: string,
  callerId: string,
  period: { start: Date; end: Date },
): Promise<{ period_end: string | null } | null> {
  const { data, error } = await admin
    .from("bank_transfer_proofs")
    .update({
      status: "approved",
      validated_by: callerId,
      validated_at: new Date().toISOString(),
      period_start: period.start.toISOString(),
      period_end: period.end.toISOString(),
    })
    .eq("id", proofId)
    .eq("status", "pending")
    .select("period_end")
    .maybeSingle();
  if (error) throw new Error(`No se pudo aprobar el proof: ${error.message}`);
  return (data as { period_end: string | null } | null) ?? null;
}

/**
 * Extiende (o crea) la suscripción del taller. El vencimiento resultante es
 * `max(actual, periodEnd)`: comparado en JS y escrito absoluto, así un reintento
 * converge en vez de apilar otro mes.
 */
async function applySubscription(
  admin: SupabaseClient,
  shopId: string,
  sub: SubscriptionRow | null,
  periodEnd: Date,
): Promise<void> {
  if (sub) {
    const target = maxDate(parseTimestamp(sub.current_period_end), periodEnd)!;
    const { error } = await admin
      .from("subscriptions")
      .update({ status: "active", current_period_end: target.toISOString() })
      .eq("id", sub.id);
    if (error) {
      throw new Error(`No se pudo extender la subscription: ${error.message}`);
    }
    return;
  }

  // Sin suscripción previa (taller migrado a mano, o import): crearla.
  const { error } = await admin.from("subscriptions").insert({
    shop_id: shopId,
    provider: PROVIDER,
    status: "active",
    plan: DEFAULT_PLAN,
    current_period_end: periodEnd.toISOString(),
  });
  if (!error) return;

  // Carrera con otra corrida: la constraint de 0011 la corta. Releer y extender
  // esa fila (mismo patrón que ensureSubscription en provisionTenant).
  if (
    error.code === "23505" &&
    error.message?.includes("subscriptions_shop_provider_unique")
  ) {
    const existing = await loadLatestSubscription(admin, shopId);
    if (!existing) {
      throw new Error(
        "subscriptions_shop_provider_unique disparó pero no se encontró la fila.",
      );
    }
    await applySubscription(admin, shopId, existing, periodEnd);
    return;
  }
  throw new Error(`No se pudo crear la subscription: ${error.message}`);
}

/**
 * Espejo denormalizado en `shops` (la verdad vive en `subscriptions`). Mismo
 * cuerpo que reactivate() en hotmart-webhook: `activated_at` solo se escribe la
 * PRIMERA vez (es la fecha de alta del taller, no la del último pago); PostgREST
 * no expresa un coalesce, así que se lee antes.
 */
async function activateShop(admin: SupabaseClient, shopId: string): Promise<void> {
  const { data: shop, error: selErr } = await admin
    .from("shops")
    .select("activated_at")
    .eq("id", shopId)
    .single();
  if (selErr) throw new Error(`Lectura de shop falló: ${selErr.message}`);

  const patch: Record<string, unknown> = {
    status: "active",
    subscription_status: "active",
  };
  if (!shop.activated_at) patch.activated_at = new Date().toISOString();

  const { error } = await admin.from("shops").update(patch).eq("id", shopId);
  if (error) throw new Error(`No se pudo reactivar el shop: ${error.message}`);
}

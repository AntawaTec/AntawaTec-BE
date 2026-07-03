// =============================================================================
// bank-transfer-approval/index.ts
// Aprobación / rechazo de una transferencia bancaria por el admin de Antawa. Es
// la segunda vía del embudo (la otra es hotmart-webhook). A DIFERENCIA del
// webhook, a esta la invoca un admin autenticado desde el dashboard (navegador):
//   - NO usa hottok.
//   - Verifica que QUIEN LLAMA es antawa_admin (JWT + rol), in-code.
//   - Aprobar dispara el provisioning idempotente vía provisionTenant.
//
// Seguridad: el gateway corre con verify_jwt = false (ver config.toml) para que
// el preflight OPTIONS —que el navegador envía SIN Authorization— no muera con
// 401 antes de llegar aquí. La auth real (JWT validado contra GoTrue + rol admin)
// se hace DENTRO de la función y es más fuerte que el gate del gateway.
//
// Las escrituras van con el cliente service_role (createAdminClient); el JWT del
// caller solo se usa para identificarlo.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
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
import { provisionTenant } from "../_shared/provisionTenant.ts";

const PROVIDER = "bank_transfer" as const;

type Decision = "approve" | "reject";

interface RequestBody {
  proofId?: string;
  decision?: Decision;
}

Deno.serve(async (req) => {
  // 1) Preflight CORS: responder ANTES de exigir auth (el navegador no manda Bearer aquí).
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  // Cliente service_role para todo (identificación del caller + escrituras).
  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error("bank-transfer-approval: configuración incompleta:", e);
    return serverError("Configuración del servidor incompleta.");
  }

  // 2) Identidad del caller: Bearer del header, validado criptográficamente por GoTrue.
  const token = extractBearer(req.headers.get("Authorization"));
  if (!token) return unauthorized("Falta el token de autorización.");

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return unauthorized("Token inválido o expirado.");
  }
  const callerId = userData.user.id;

  // 3) Autorización: el caller debe ser antawa_admin.
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerId)
    .maybeSingle();
  if (profileErr) {
    console.error("bank-transfer-approval: lectura de profile falló:", profileErr);
    return serverError("No se pudo verificar el rol del usuario.");
  }
  if (!profile || profile.role !== "antawa_admin") {
    return forbidden("Se requiere rol antawa_admin.");
  }

  // 4) Body.
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
    // 5) Cargar el proof.
    const { data: proof, error: proofErr } = await admin
      .from("bank_transfer_proofs")
      .select("id, business_name, email, status, shop_id")
      .eq("id", proofId)
      .maybeSingle();
    if (proofErr) throw new Error(`Lectura del proof falló: ${proofErr.message}`);
    if (!proof) return notFound("No existe el comprobante de transferencia.");

    // 6) Idempotencia: si ya no está pending, devolver el estado actual (tolera doble clic).
    if (proof.status !== "pending") {
      return ok({
        status: proof.status,
        shopId: proof.shop_id,
        alreadyProcessed: true,
      });
    }

    // 7) Rechazo: marcar rejected, sin crear tenant.
    if (decision === "reject") {
      await markValidated(admin, proofId, {
        status: "rejected",
        validatedBy: callerId,
      });
      console.log(
        `bank-transfer-approval: proof ${proofId} RECHAZADO por admin ${callerId}.`,
      );
      return ok({ status: "rejected" });
    }

    // 8) Aprobación: provisionar PRIMERO; recién con éxito marcar approved + shop_id.
    //    Si provisionTenant falla, el proof queda pending y un retry reprocesa
    //    (provisionTenant es idempotente/re-entrante).
    const result = await provisionTenant(admin, {
      businessName: proof.business_name,
      email: proof.email,
      provider: PROVIDER,
      redirectTo: Deno.env.get("ONBOARDING_REDIRECT_URL") || undefined,
    });

    await markValidated(admin, proofId, {
      status: "approved",
      validatedBy: callerId,
      shopId: result.shopId,
    });

    console.log(
      `bank-transfer-approval: proof ${proofId} APROBADO por admin ${callerId}. ` +
        `shop=${result.shopId} created=${result.created}`,
    );
    return ok({ status: "approved", shopId: result.shopId, created: result.created });
  } catch (e) {
    // 9) Error real (DB / provisioning) -> 500. El proof queda como estaba.
    console.error(`bank-transfer-approval: error procesando proof ${proofId}:`, e);
    return serverError("Error procesando la aprobación.");
  }
});

// --- Helpers -----------------------------------------------------------------

function extractBearer(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : null;
}

async function markValidated(
  admin: SupabaseClient,
  proofId: string,
  opts: {
    status: "approved" | "rejected";
    validatedBy: string;
    shopId?: string;
  },
): Promise<void> {
  const patch: Record<string, unknown> = {
    status: opts.status,
    validated_by: opts.validatedBy,
    validated_at: new Date().toISOString(),
  };
  if (opts.shopId) patch.shop_id = opts.shopId;

  const { error } = await admin
    .from("bank_transfer_proofs")
    .update(patch)
    .eq("id", proofId);
  if (error) {
    throw new Error(`No se pudo actualizar el proof: ${error.message}`);
  }
}

// =============================================================================
// whatsapp-webhook/index.ts
// Receptor de los RECIBOS DE ENTREGA de la WhatsApp Cloud API (Meta).
//
// Por qué existe: hasta ahora `notification_log.status = 'sent'` significaba solo
// "Meta devolvió 200" (la Cloud API acepta el mensaje y lo entrega después). Sin
// webhooks, la única forma de saber si un cliente REALMENTE recibió algo era
// entrar a Meta Business Manager a mirar Insights a mano. Esta función asienta
// sent/delivered/read/failed en la fila que originó el mensaje.
//
// Correlación: Meta no conoce nuestros uuid, así que la llave es el `wamid` que
// la Cloud API devuelve al aceptar el envío y que notification-dispatch guarda en
// `notification_log.provider_message_id` (migración 0038).
//
// La escritura sobre `notification_log` (rank de estados + la REGLA CRÍTICA de
// que un fallo de ENTREGA no toca `status`) vive en `_shared/deliveryReceipts.ts`,
// compartida con `twilio-status-webhook`. El porqué de las dos reglas está ahí.
//
// Auth (no hay JWT posible: el que llama es Meta):
//   GET  -> handshake de verificación, `hub.verify_token` == WHATSAPP_WEBHOOK_VERIFY_TOKEN.
//   POST -> firma HMAC-SHA256 del cuerpo CRUDO en `x-hub-signature-256`, con
//           WHATSAPP_APP_SECRET (el App Secret de la app de Meta).
// Mismo patrón que `hottok` en hotmart-webhook y `x-cron-secret` en
// notification-dispatch: si el secret NO está seteado se permite (dev local); en
// prod DEBE estar seteado.
//
// Responde 200 a todo payload bien firmado —incluidos los eventos que ignoramos—
// para que Meta no lo reintente ni degrade la suscripción.
// =============================================================================

import { createAdminClient } from "../_shared/supabaseAdmin.ts";
import { applyDeliveryReceipt, timingSafeEqual } from "../_shared/deliveryReceipts.ts";
import { badRequest, methodNotAllowed, ok, serverError, unauthorized } from "../_shared/response.ts";

interface MetaStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: Array<{ code?: number; title?: string; message?: string; error_data?: { details?: string } }>;
}

/** Segundos unix (string, como los manda Meta) -> ISO. Cae en `now()` si no parsea. */
function tsToIso(ts: string | undefined): string {
  const secs = Number(ts);
  return Number.isFinite(secs) && secs > 0
    ? new Date(secs * 1000).toISOString()
    : new Date().toISOString();
}

/** Texto legible del error de entrega que reporta Meta (code + title + details). */
function errorText(st: MetaStatus): string | null {
  const e = st.errors?.[0];
  if (!e) return null;
  const detail = e.error_data?.details ?? e.message ?? e.title ?? "sin detalle";
  return `Meta entrega ${e.code ?? "?"}: ${detail}`;
}

async function signatureIsValid(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
  const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(hex, header.slice("sha256=".length));
}

Deno.serve(async (req: Request) => {
  // --- Handshake de verificación (Meta lo dispara al guardar la URL) ---------
  if (req.method === "GET") {
    const url = new URL(req.url);
    const expected = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN");
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") ?? "";
    if (!expected) return serverError("WHATSAPP_WEBHOOK_VERIFY_TOKEN no configurado");
    if (mode !== "subscribe" || !token || !timingSafeEqual(token, expected)) {
      return unauthorized("hub.verify_token inválido");
    }
    // Meta espera el challenge CRUDO (text/plain), no JSON.
    return new Response(challenge, { status: 200, headers: { "content-type": "text/plain" } });
  }

  if (req.method !== "POST") return methodNotAllowed();

  // --- Firma: sobre el cuerpo CRUDO, ANTES de parsear -----------------------
  const raw = await req.text();
  const appSecret = Deno.env.get("WHATSAPP_APP_SECRET");
  if (appSecret && !(await signatureIsValid(raw, req.headers.get("x-hub-signature-256"), appSecret))) {
    return unauthorized("x-hub-signature-256 inválido");
  }

  let body: { entry?: Array<{ changes?: Array<{ value?: { statuses?: MetaStatus[] } }> }> };
  try {
    body = JSON.parse(raw);
  } catch {
    return badRequest("cuerpo no es JSON");
  }

  const statuses = (body.entry ?? [])
    .flatMap((e) => e.changes ?? [])
    .flatMap((c) => c.value?.statuses ?? [])
    .filter((s): s is MetaStatus & { id: string; status: string } => Boolean(s.id && s.status));

  // Los mensajes ENTRANTES (respuestas de clientes) llegan por el mismo webhook y
  // los ignoramos por diseño: las plantillas avisan que el canal es de una vía.
  if (statuses.length === 0) return ok({ updated: 0, ignored: true });

  try {
    const admin = createAdminClient();
    let updated = 0;

    for (const st of statuses) {
      // El vocabulario de Meta (sent/delivered/read/failed) YA es el común: se
      // pasa tal cual al asiento compartido, sin traducción.
      const applied = await applyDeliveryReceipt(admin, {
        providerMessageId: st.id,
        status: st.status,
        at: tsToIso(st.timestamp),
        error: st.status === "failed"
          ? errorText(st) ?? "entrega fallida (sin detalle de Meta)"
          : null,
      });
      if (applied) updated++;
    }

    return ok({ received: statuses.length, updated });
  } catch (e) {
    // 500 -> Meta reintenta. Los estados son idempotentes (last-write-wins con
    // rank), así que un reintento no puede corromper nada.
    return serverError(e instanceof Error ? e.message : String(e));
  }
});

// =============================================================================
// twilio-status-webhook/index.ts
// Receptor de los RECIBOS DE ENTREGA de Twilio (el gemelo de `whatsapp-webhook`
// para el proveedor alternativo, ver `_shared/whatsappTransport.ts`).
//
// Twilio manda un POST **form-urlencoded** por cada cambio de estado del mensaje
// al `StatusCallback` configurado (en el sender de WhatsApp o por mensaje):
//   MessageSid, MessageStatus (queued|sending|sent|delivered|read|failed|
//   undelivered), y ErrorCode/ErrorMessage cuando corresponde.
//
// Correlación: el `MessageSid` (SM…) que Twilio devolvió al aceptar el envío y
// que notification-dispatch guardó en `notification_log.provider_message_id`
// (misma columna que el wamid de Meta — un solo pipeline, dos proveedores).
//
// El asiento en `notification_log` es el COMPARTIDO (`_shared/deliveryReceipts.ts`):
// mismo rank (accepted<sent<delivered<read<failed, nunca retrocede, `read`
// completa `delivered_at`) y misma regla crítica de que un fallo de ENTREGA NO
// toca `status` — el drenado reencola `failed` y reenviaría un mensaje que
// Twilio ya aceptó y cobró.
//
// Auth (no hay JWT posible: el que llama es Twilio): firma `X-Twilio-Signature`
// = base64(HMAC-SHA1(TWILIO_AUTH_TOKEN, url + params ordenados por clave)).
// Mismo patrón que el resto del repo: si el secret NO está seteado se permite
// (dev local); en prod TWILIO_AUTH_TOKEN DEBE estar seteado.
//
// Responde 200 a todo POST bien firmado —incluidos los estados que ignoramos—
// porque Twilio reintenta ante cualquier respuesta que no sea 2xx.
// =============================================================================

import { createAdminClient } from "../_shared/supabaseAdmin.ts";
import { applyDeliveryReceipt } from "../_shared/deliveryReceipts.ts";
import { mapTwilioStatus, verifyTwilioSignature } from "../_shared/twilio.ts";
import { forbidden, methodNotAllowed, ok, serverError } from "../_shared/response.ts";

/**
 * La URL que Twilio firmó. Preferimos la configurada (`TWILIO_STATUS_CALLBACK_URL`,
 * el mismo valor que se pega en el sender y que el transporte manda como
 * `StatusCallback`) porque detrás del gateway de Supabase el `req.url` puede no
 * coincidir con la URL pública — y una URL distinta da una firma distinta.
 */
function callbackUrl(req: Request): string {
  const configured = Deno.env.get("TWILIO_STATUS_CALLBACK_URL");
  if (configured) return configured;
  const u = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}${u.pathname}${u.search}` : req.url;
}

/** Motivo legible del fallo de entrega que reporta Twilio. */
function errorText(code: string | null, message: string | null): string | null {
  if (!code && !message) return null;
  return `Twilio entrega ${code ?? "?"}: ${message ?? "sin detalle"}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return methodNotAllowed();

  // Cuerpo CRUDO primero: la firma se calcula sobre los params, y necesitamos
  // leerlos sin consumir el body dos veces.
  const raw = await req.text();
  const form = new URLSearchParams(raw);
  const params: Record<string, string> = {};
  for (const [k, v] of form) params[k] = v;

  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN");
  if (authToken) {
    const valid = await verifyTwilioSignature(
      authToken,
      callbackUrl(req),
      params,
      req.headers.get("x-twilio-signature"),
    );
    if (!valid) return forbidden("x-twilio-signature inválida");
  }

  const sid = params["MessageSid"] ?? params["SmsSid"] ?? null;
  const status = mapTwilioStatus(params["MessageStatus"] ?? params["SmsStatus"] ?? null);
  // Estado desconocido o callback sin sid: 200 igual (si devolviéramos 4xx,
  // Twilio lo reintentaría para siempre).
  if (!sid || !status) return ok({ updated: 0, ignored: true });

  try {
    const admin = createAdminClient();
    // Twilio no manda timestamp del evento en el callback: usamos la hora de
    // recepción. La diferencia con el instante real es de segundos.
    const applied = await applyDeliveryReceipt(admin, {
      providerMessageId: sid,
      status,
      at: new Date().toISOString(),
      error: status === "failed"
        ? errorText(params["ErrorCode"] ?? null, params["ErrorMessage"] ?? null) ??
          "entrega fallida (sin detalle de Twilio)"
        : null,
    });

    return ok({ received: 1, updated: applied ? 1 : 0 });
  } catch (e) {
    // 500 -> Twilio reintenta. Los estados son idempotentes (rank + no retroceso),
    // así que un reintento no puede corromper nada.
    return serverError(e instanceof Error ? e.message : String(e));
  }
});

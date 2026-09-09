// =============================================================================
// _shared/twilio.ts
// TODO lo específico de Twilio, en un solo lugar y PURO (sin I/O): armado del
// cuerpo de `Messages.json`, mapeo de sus estados al vocabulario común de
// `notification_log` y validación de la firma `X-Twilio-Signature`.
//
// Por qué existe Twilio como alternativa a Meta: la WABA de la app quedó
// restringida por el cobro (Meta factura contra una tarjeta del cliente y el
// cargo venía rebotando). Twilio es un BSP: factura ÉL contra su propia línea de
// crédito con Meta, así que el canal deja de depender de que el cobro de Meta
// entre. El swap se decide por env (`WHATSAPP_PROVIDER`) y no toca el pipeline:
// el render (`notificationTemplates.ts`) y el `notification_log` son idénticos.
//
// Diferencia de contrato que importa: Meta acepta el NOMBRE de la plantilla
// (`appointment_confirmed`), Twilio exige el **Content SID** (`HX…`) que devuelve
// su Content Template Builder. Ese mapeo nombre→SID viaja en el secret
// `TWILIO_CONTENT_SIDS` (JSON) en vez de hardcodearse: los SIDs son por cuenta y
// se re-crean si algún día hay que rehacer las plantillas.
// =============================================================================

import { timingSafeEqual } from "./deliveryReceipts.ts";

/** Estados de Twilio → el mismo vocabulario que ya usa el webhook de Meta. */
const TWILIO_STATUS: Record<string, string> = {
  // Twilio todavía no lo entregó a Meta: equivale al "aceptado" que ya escribe
  // notification-dispatch al guardar el sid.
  queued: "accepted",
  sending: "accepted",
  sent: "sent",
  delivered: "delivered",
  read: "read",
  // `undelivered` = Meta lo rechazó (número inválido, ventana cerrada, etc.).
  // Para nosotros es lo mismo que `failed`: no llegó y no se reintenta solo.
  failed: "failed",
  undelivered: "failed",
};

/** Devuelve el estado común, o null si Twilio manda uno que no conocemos. */
export function mapTwilioStatus(raw: string | null | undefined): string | null {
  if (!raw) return null;
  return TWILIO_STATUS[raw.toLowerCase()] ?? null;
}

/**
 * Direcciones de WhatsApp en Twilio: siempre `whatsapp:+E164`. El `From` se
 * carga como secret y es fácil que se pegue con o sin el prefijo, así que lo
 * normalizamos acá en vez de confiar en cómo quedó tipeado en el Dashboard.
 */
export function twilioWhatsAppAddress(raw: string): string {
  const v = raw.trim();
  return v.startsWith("whatsapp:") ? v : `whatsapp:${v}`;
}

/**
 * Parsea `TWILIO_CONTENT_SIDS` (JSON `{"<plantilla>":"HX…"}`). Devuelve `{}` si
 * falta o no parsea: quedarse sin mapa hace fallar el envío con un error legible
 * ("sin ContentSid para X") en vez de reventar el drenado entero.
 */
export function parseContentSids(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string" && v.trim()) out[k] = v.trim();
    }
    return out;
  } catch {
    return {};
  }
}

export interface TwilioMessageParams {
  from: string; // TWILIO_WHATSAPP_FROM, con o sin prefijo `whatsapp:`
  msisdn: string; // el que devuelve toWhatsAppMsisdn(): dígitos SIN '+'
  contentSid: string; // HX… del Content Template Builder
  components: string[]; // mismas variables posicionales que manda Meta
  statusCallback?: string | null; // TWILIO_STATUS_CALLBACK_URL (opcional)
}

/**
 * Cuerpo `application/x-www-form-urlencoded` de `POST /Messages.json`.
 *
 * `ContentVariables` es un JSON con las variables POSICIONALES **1-based**
 * (`{"1":…,"2":…}`) — el mismo orden que `RenderedNotification.components`, que
 * es lo que ya consume el camino de Meta. Mantener una sola fuente de orden es
 * lo que hace que las 6 plantillas se puedan re-crear en Twilio carácter por
 * carácter sin tocar el render.
 */
export function buildTwilioMessageForm(p: TwilioMessageParams): URLSearchParams {
  const vars: Record<string, string> = {};
  p.components.forEach((value, i) => {
    vars[String(i + 1)] = value;
  });

  const form = new URLSearchParams({
    // `toWhatsAppMsisdn` devuelve dígitos pelados (593…): Twilio exige E.164 con '+'.
    To: `whatsapp:+${p.msisdn}`,
    From: twilioWhatsAppAddress(p.from),
    ContentSid: p.contentSid,
    ContentVariables: JSON.stringify(vars),
  });
  if (p.statusCallback) form.set("StatusCallback", p.statusCallback);
  return form;
}

/**
 * Firma de Twilio: base64(HMAC-SHA1(authToken, url + concat(k+v de los params
 * POST ordenados por clave))).
 *
 * La URL es la EXACTA que Twilio pidió (con querystring si la hay); por eso el
 * webhook prefiere `TWILIO_STATUS_CALLBACK_URL` antes que reconstruirla del
 * request: detrás del gateway de Supabase el `req.url` no siempre coincide con
 * la URL pública, y una URL distinta da una firma distinta.
 *
 * (Twilio concatena los valores repetidos de una misma clave; los status
 * callbacks no repiten claves, así que acá alcanza con un Record.)
 */
export async function twilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): Promise<string> {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], url);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

/** `X-Twilio-Signature` válida para (url, params). Comparación constant-time. */
export async function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  header: string | null,
): Promise<boolean> {
  if (!header) return false;
  return timingSafeEqual(await twilioSignature(authToken, url, params), header);
}

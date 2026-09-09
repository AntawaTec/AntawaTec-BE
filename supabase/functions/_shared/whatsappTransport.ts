// =============================================================================
// _shared/whatsappTransport.ts
// El ÚNICO archivo que cambia para pasar de SANDBOX a envío real, y también el
// único que sabe QUÉ proveedor manda el WhatsApp.
//
// Sandbox (WHATSAPP_DRY_RUN=true o sin credenciales del proveedor elegido): no
// llama a nadie, loguea y devuelve ok — el dispatcher marca la fila 'sent' con
// payload.rendered + dry_run:true.
// Real: fetch a la API del proveedor con la plantilla registrada (nombre/SID +
// variables posicionales). El render ya produce `components` (ver
// notificationTemplates.ts), así que cada proveedor solo re-empaqueta eso.
//
// DOS PROVEEDORES (`WHATSAPP_PROVIDER`, default "meta"):
//   - "meta"   → WhatsApp Cloud API directa. Meta factura contra la tarjeta
//                cargada en la WABA.
//   - "twilio" → Twilio como BSP: factura ÉL (su propia línea de crédito con
//                Meta), que es la razón de que exista esta rama — la WABA quedó
//                restringida porque Meta no logra cobrar y el canal se corta.
// El resto del pipeline (encolado, dedupe, reintentos, notification_log) es
// idéntico: cambia el transporte, no la semántica. `messageId` sigue siendo la
// llave de correlación del webhook de estados (wamid en Meta, `SM…` en Twilio).
// =============================================================================
import type { RenderedNotification } from "./notificationTemplates.ts";
import { toWhatsAppMsisdn } from "./phone.ts";
import { buildTwilioMessageForm, parseContentSids, twilioWhatsAppAddress } from "./twilio.ts";

export type WhatsAppProvider = "meta" | "twilio";

export interface SendResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
  /**
   * Id que devuelve el proveedor al ACEPTAR el mensaje (wamid en Meta, `SM…` en
   * Twilio). Es la única llave con la que el webhook de estados puede encontrar
   * la fila de `notification_log`: ningún proveedor conoce nuestros uuid.
   * Ausente en dry-run.
   */
  messageId?: string;
}

/** Proveedor activo. Cualquier valor distinto de "twilio" cae en Meta (default seguro). */
export function whatsappProvider(): WhatsAppProvider {
  return (Deno.env.get("WHATSAPP_PROVIDER") ?? "meta").trim().toLowerCase() === "twilio"
    ? "twilio"
    : "meta";
}

/** ¿Están las credenciales del proveedor elegido? Sin ellas no se sale de dry-run. */
function hasCredentials(provider: WhatsAppProvider): boolean {
  if (provider === "twilio") {
    return Boolean(
      Deno.env.get("TWILIO_ACCOUNT_SID") &&
        Deno.env.get("TWILIO_AUTH_TOKEN") &&
        Deno.env.get("TWILIO_WHATSAPP_FROM") &&
        Deno.env.get("TWILIO_CONTENT_SIDS"),
    );
  }
  return Boolean(Deno.env.get("WHATSAPP_TOKEN") && Deno.env.get("WHATSAPP_PHONE_ID"));
}

function isDryRun(): boolean {
  // Dry-run por defecto: solo envía de verdad si está explícitamente apagado Y
  // hay credenciales DEL PROVEEDOR ELEGIDO. Poner WHATSAPP_PROVIDER=twilio sin
  // los secrets de Twilio deja el canal en sandbox (no manda nada por Meta con
  // la config a medio hacer, ni revienta el drenado).
  const flag = (Deno.env.get("WHATSAPP_DRY_RUN") ?? "true").toLowerCase();
  return flag !== "false" || !hasCredentials(whatsappProvider());
}

export async function sendWhatsApp(
  to: string | null,
  template: string,
  rendered: RenderedNotification,
): Promise<SendResult> {
  if (!to) return { ok: false, dryRun: isDryRun(), error: "cliente sin whatsapp_number" };

  // Normalizamos ANTES de la rama dry-run a propósito: así la corrida de sandbox
  // que absorbe el backlog histórico deja los números impresentables marcados
  // 'failed' con un error legible, y sirve de auditoría previa al encendido.
  const msisdn = toWhatsAppMsisdn(to);
  if (!msisdn) {
    return { ok: false, dryRun: isDryRun(), error: `whatsapp_number no normalizable: ${to}` };
  }

  if (isDryRun()) {
    console.log(`[whatsapp:dry-run] → ${msisdn} [${template}] ${rendered.text}`);
    return { ok: true, dryRun: true };
  }

  return whatsappProvider() === "twilio"
    ? await sendViaTwilio(msisdn, template, rendered)
    : await sendViaMeta(msisdn, template, rendered);
}

// --- Camino real: Meta (WhatsApp Cloud API directa) --------------------------
async function sendViaMeta(
  msisdn: string,
  template: string,
  rendered: RenderedNotification,
): Promise<SendResult> {
  try {
    const phoneId = Deno.env.get("WHATSAPP_PHONE_ID")!;
    const token = Deno.env.get("WHATSAPP_TOKEN")!;
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: msisdn,
        type: "template",
        template: {
          name: template, // la plantilla registrada en Meta lleva el mismo nombre del enum
          language: { code: "es" },
          components: [
            { type: "body", parameters: rendered.components.map((t) => ({ type: "text", text: t })) },
          ],
        },
      }),
    });
    if (!res.ok) return { ok: false, dryRun: false, error: `Meta ${res.status}: ${await res.text()}` };

    // 200 = Meta ACEPTÓ el mensaje (no que lo entregó). El wamid que viene acá se
    // guarda en notification_log y lo usa el webhook para asentar delivered/read.
    // Si el body no parsea, el envío igual fue bueno: no lo convertimos en error,
    // solo perdemos la trazabilidad de ESE mensaje.
    let messageId: string | undefined;
    try {
      const body = await res.json() as { messages?: Array<{ id?: string }> };
      messageId = body.messages?.[0]?.id;
    } catch {
      messageId = undefined;
    }
    return { ok: true, dryRun: false, messageId };
  } catch (e) {
    return { ok: false, dryRun: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// --- Camino real: Twilio (BSP) ----------------------------------------------
async function sendViaTwilio(
  msisdn: string,
  template: string,
  rendered: RenderedNotification,
): Promise<SendResult> {
  const accountSid = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const authToken = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const from = twilioWhatsAppAddress(Deno.env.get("TWILIO_WHATSAPP_FROM")!);

  // Twilio no acepta el NOMBRE de la plantilla: exige el Content SID (HX…) que
  // devuelve su Content Template Builder. Si falta el mapeo cortamos ANTES de la
  // red: un POST sin ContentSid gastaría un intento del reintento para volver
  // siempre con el mismo 400.
  const contentSid = parseContentSids(Deno.env.get("TWILIO_CONTENT_SIDS"))[template];
  if (!contentSid) {
    return { ok: false, dryRun: false, error: `twilio: sin ContentSid para ${template}` };
  }

  try {
    const form = buildTwilioMessageForm({
      from,
      msisdn,
      contentSid,
      components: rendered.components,
      statusCallback: Deno.env.get("TWILIO_STATUS_CALLBACK_URL") ?? null,
    });
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${accountSid}:${authToken}`)}`,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      },
    );
    if (!res.ok) {
      return { ok: false, dryRun: false, error: `Twilio ${res.status}: ${await res.text()}` };
    }

    // 201 = Twilio ACEPTÓ el mensaje (status `queued`/`accepted`), no que lo
    // entregó. El `sid` (SM…) es lo que después asienta twilio-status-webhook.
    // Mismo criterio que en Meta: si el body no parsea, el envío fue bueno igual.
    let messageId: string | undefined;
    try {
      const body = await res.json() as { sid?: string };
      messageId = body.sid;
    } catch {
      messageId = undefined;
    }
    return { ok: true, dryRun: false, messageId };
  } catch (e) {
    return { ok: false, dryRun: false, error: e instanceof Error ? e.message : String(e) };
  }
}

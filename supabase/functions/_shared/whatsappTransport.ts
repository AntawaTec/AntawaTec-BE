// =============================================================================
// _shared/whatsappTransport.ts
// El ÚNICO archivo que cambia para pasar de SANDBOX a Meta real.
//
// Sandbox (WHATSAPP_DRY_RUN=true o sin token): no llama a nadie, loguea y devuelve
// ok — el dispatcher marca la fila 'sent' con payload.rendered + dry_run:true.
// Real (futuro): fetch a la WhatsApp Cloud API con la plantilla registrada
// (template name + components estructurados). El render ya produce `components`
// (ver notificationTemplates.ts), así que el swap es solo el cuerpo de este fetch.
// =============================================================================
import type { RenderedNotification } from "./notificationTemplates.ts";

export interface SendResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
}

function isDryRun(): boolean {
  // Dry-run por defecto: solo envía de verdad si está explícitamente apagado Y hay token.
  const flag = (Deno.env.get("WHATSAPP_DRY_RUN") ?? "true").toLowerCase();
  const hasToken = Boolean(Deno.env.get("WHATSAPP_TOKEN") && Deno.env.get("WHATSAPP_PHONE_ID"));
  return flag !== "false" || !hasToken;
}

export async function sendWhatsApp(
  to: string | null,
  template: string,
  rendered: RenderedNotification,
): Promise<SendResult> {
  if (!to) return { ok: false, dryRun: isDryRun(), error: "cliente sin whatsapp_number" };

  if (isDryRun()) {
    console.log(`[whatsapp:dry-run] → ${to} [${template}] ${rendered.text}`);
    return { ok: true, dryRun: true };
  }

  // --- Camino real (futuro, tras aprobación de Meta) ---
  try {
    const phoneId = Deno.env.get("WHATSAPP_PHONE_ID")!;
    const token = Deno.env.get("WHATSAPP_TOKEN")!;
    const res = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
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
    return { ok: true, dryRun: false };
  } catch (e) {
    return { ok: false, dryRun: false, error: e instanceof Error ? e.message : String(e) };
  }
}

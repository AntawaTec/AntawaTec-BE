// =============================================================================
// _shared/emailTransport.ts
// El ÚNICO archivo que cambia para pasar de SANDBOX a Resend real. Espejo exacto
// de whatsappTransport.ts, misma forma y mismas garantías.
//
// Sandbox (EMAIL_DRY_RUN != "false" o sin API key): no llama a nadie, loguea y
// devuelve ok — el dispatcher marca la fila 'sent' con payload.rendered + dry_run.
// Real: POST a la API de Resend con el HTML que produjo emailTemplates.ts.
//
// Dos detalles del remitente que NO son cosméticos:
//   - `from` = "Nombre del taller <notificaciones@mail.antwt.com>". El dominio
//     verificado en Resend es uno solo y es el SUBDOMINIO `mail.antwt.com` (el apex
//     `antwt.com` NO está verificado: Resend responde 403 "domain is not verified" y
//     la fila muere tras 5 intentos — pasó en prod del 19 al 27-ago-2026). Lo
//     comparten los ~18 talleres; el display name es lo único que le dice al cliente
//     de qué taller viene el correo. Mismo problema que en WhatsApp (una WABA, un
//     número), misma solución: identidad en el contenido.
//   - `reply_to` = shops.contact_email cuando exista. La casilla del remitente NO se
//     monitorea; sin reply-to, un cliente que responde le escribe al vacío. Con él,
//     la respuesta cae en el taller correcto — es la contracara del aviso de "una
//     vía" que sí aplica en WhatsApp.
// =============================================================================

export interface EmailSendResult {
  ok: boolean;
  dryRun: boolean;
  error?: string;
}

export interface EmailSendOptions {
  fromName?: string | null; // nombre del taller (display name del remitente)
  replyTo?: string | null; // shops.contact_email
}

// Mismo subdominio que usa el SMTP de Auth en el dashboard. Se puede pisar con EMAIL_FROM.
const DEFAULT_FROM = "notificaciones@mail.antwt.com";
// Suficiente para descartar basura evidente sin re-implementar RFC 5322.
const EMAIL_RE = /.+@.+\..+/;

function isDryRun(): boolean {
  // Dry-run por defecto: solo envía de verdad si está explícitamente apagado Y hay key.
  const flag = (Deno.env.get("EMAIL_DRY_RUN") ?? "true").toLowerCase();
  const hasKey = Boolean(Deno.env.get("RESEND_API_KEY"));
  return flag !== "false" || !hasKey;
}

export async function sendEmail(
  to: string | null,
  subject: string,
  html: string,
  opts: EmailSendOptions = {},
): Promise<EmailSendResult> {
  // Cliente sin email: la fila igual se encoló (ver notification-dispatch) y falla
  // acá, determinística y auditable. No encolarla sería peor: sin fila de dedupe,
  // cargarle el email al cliente meses después dispararía un "Recibimos tu vehículo"
  // de una orden vieja.
  if (!to) return { ok: false, dryRun: isDryRun(), error: "cliente sin email" };

  // Validamos ANTES de la rama dry-run a propósito, igual que la normalización de
  // MSISDN: así la corrida de absorción del backlog en sandbox deja marcados los
  // emails impresentables y sirve de auditoría previa al encendido.
  const addr = to.trim();
  if (!EMAIL_RE.test(addr)) {
    return { ok: false, dryRun: isDryRun(), error: `email inválido: ${to}` };
  }

  if (isDryRun()) {
    console.log(`[email:dry-run] → ${addr} [${subject}]`);
    return { ok: true, dryRun: true };
  }

  // --- Camino real ---
  try {
    const key = Deno.env.get("RESEND_API_KEY")!;
    const fromAddr = Deno.env.get("EMAIL_FROM") ?? DEFAULT_FROM;
    const fromName = (opts.fromName ?? "").trim();
    const body: Record<string, unknown> = {
      from: fromName ? `${fromName} <${fromAddr}>` : fromAddr,
      to: [addr],
      subject,
      html,
    };
    const replyTo = (opts.replyTo ?? "").trim();
    if (replyTo && EMAIL_RE.test(replyTo)) body.reply_to = replyTo;

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, dryRun: false, error: `Resend ${res.status}: ${await res.text()}` };
    return { ok: true, dryRun: false };
  } catch (e) {
    return { ok: false, dryRun: false, error: e instanceof Error ? e.message : String(e) };
  }
}

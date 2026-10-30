// =============================================================================
// trial-reminder/index.ts
// Recordatorio "tu prueba termina" al DUEÑO de un taller en prueba por código
// promocional (0047/0048). La invoca pg_cron una vez al día (13:00 UTC = 08:00
// Ecuador, job `trial-reminder` de 0048) o un operador a mano.
//
// Qué hace: busca las subscriptions `provider = 'trial'`, `status = 'active'`,
// que vencen dentro de los próximos REMINDER_DAYS días y que todavía NO
// recibieron el aviso (`trial_reminder_sent_at is null`), y le manda UN correo
// al contact_email del taller. Es un aviso, no un corte: al vencer, el admin
// suspende A MANO desde /admin (V1 no corta nada automáticamente).
//
// Idempotencia: `trial_reminder_sent_at` se escribe SOLO cuando el envío dio ok
// (dry-run incluido, igual que notification-dispatch marca 'sent' en sandbox:
// así encender EMAIL_DRY_RUN=false después no dispara una ráfaga de avisos
// atrasados). Un fallo de Resend deja la fila en null y el cron de mañana
// reintenta — sigue dentro de la ventana de 7 días.
//
// Por qué no pasa por notification_log: esa cola es de avisos AL CLIENTE FINAL
// en nombre del taller (plantillas del enum notification_template, dedupe por
// entidad, WhatsApp + email). Este es AntawaTec escribiéndole a su propio
// cliente, uno por prueba: la columna en subscriptions es el dedupe entero.
//
// Auth: `verify_jwt = false` (pg_cron no tiene JWT). El header x-cron-secret
// debe coincidir con CRON_SECRET; si CRON_SECRET no está seteado (dev local),
// permite — mismo bloque que notification-dispatch. En prod DEBE estar seteado.
// =============================================================================

import { createAdminClient, type SupabaseClient } from "../_shared/supabaseAdmin.ts";
import {
  methodNotAllowed,
  ok,
  preflight,
  serverError,
  unauthorized,
} from "../_shared/response.ts";
import { selectAll } from "../_shared/paginate.ts";
import { sendEmail } from "../_shared/emailTransport.ts";
import { renderTrialReminder } from "../_shared/trialReminderEmail.ts";

const LABEL = "trial-reminder";
const REMINDER_DAYS = 7;
const DAY_MS = 86_400_000;

interface ShopEmbed {
  name: string | null;
  contact_email: string | null;
  status: string | null;
}

interface TrialRow {
  id: string;
  shop_id: string;
  current_period_end: string;
  // PostgREST devuelve el embed many-to-one como objeto; se tipa laxo por si
  // alguna versión lo serializa como array.
  shops: ShopEmbed | ShopEmbed[] | null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();
  if (req.method !== "POST") return methodNotAllowed();

  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return unauthorized("x-cron-secret inválido");
  }

  let admin: SupabaseClient;
  try {
    admin = createAdminClient();
  } catch (e) {
    console.error(`${LABEL}: configuración incompleta:`, e);
    return serverError("Configuración del servidor incompleta.");
  }

  try {
    const now = new Date();
    const rows = await loadDueTrials(admin, now);

    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let dryRun = false;

    for (const row of rows) {
      const shop = Array.isArray(row.shops) ? row.shops[0] : row.shops;
      const to = (shop?.contact_email ?? "").trim();
      // Un taller ya suspendido no necesita "se va a suspender"; sin email no
      // hay a quién avisar. Ambos quedan en null: si el admin los reactiva o
      // les carga el email dentro de la ventana, el próximo tick los toma.
      if (!shop || shop.status === "suspended" || !to) {
        skipped++;
        continue;
      }

      const { subject, html } = renderTrialReminder({
        shopName: shop.name ?? "",
        periodEnd: new Date(row.current_period_end),
        now,
      });
      const res = await sendEmail(to, subject, html, {
        fromName: "AntawaTec",
        replyTo: "soporte@antwt.com",
      });
      dryRun = dryRun || res.dryRun;

      if (!res.ok) {
        failed++;
        console.error(`${LABEL}: envío falló sub=${row.id} shop=${row.shop_id}: ${res.error}`);
        continue;
      }

      // `.is(..., null)` en el UPDATE: si dos ticks se pisan (manual + cron), el
      // segundo no reescribe la fecha del primero. El correo duplicado en esa
      // carrera es aceptable (un tick manual es una decisión del operador).
      const { error: updErr } = await admin
        .from("subscriptions")
        .update({ trial_reminder_sent_at: new Date().toISOString() })
        .eq("id", row.id)
        .is("trial_reminder_sent_at", null);
      if (updErr) {
        // El correo YA salió: mañana se reenviaría. Se loguea fuerte para que
        // el operador lo marque a mano si se repite.
        console.error(
          `${LABEL}: correo enviado pero no se pudo marcar sub=${row.id}: ${updErr.message}`,
        );
      }
      sent++;
    }

    console.log(
      `${LABEL}: scanned=${rows.length} sent=${sent} failed=${failed} ` +
        `skipped=${skipped} dryRun=${dryRun}`,
    );
    return ok({ scanned: rows.length, sent, failed, dryRun });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LABEL} error:`, msg);
    return serverError(msg);
  }
});

/** Pruebas activas que vencen en (now, now + REMINDER_DAYS] sin aviso todavía. */
async function loadDueTrials(admin: SupabaseClient, now: Date): Promise<TrialRow[]> {
  const nowIso = now.toISOString();
  const untilIso = new Date(now.getTime() + REMINDER_DAYS * DAY_MS).toISOString();
  // selectAll aunque hoy sean pocas: la lección de 0044 es que un select sin
  // paginar se trunca en max_rows SIN error.
  return await selectAll<TrialRow>(() =>
    admin
      .from("subscriptions")
      .select("id, shop_id, current_period_end, shops(name, contact_email, status)")
      .eq("provider", "trial")
      .eq("status", "active")
      .is("trial_reminder_sent_at", null)
      .gt("current_period_end", nowIso)
      .lte("current_period_end", untilIso)
  );
}

// =============================================================================
// notification-dispatch — pipeline de notificaciones (RUNBOOK 3.8), SANDBOX.
//
// Invocada por cron (pg_cron+pg_net) o manualmente. Dos pasos por corrida:
//   A) BARRIDO state-driven: encuentra eventos del ciclo de vida sin su fila de
//      notificación y la inserta 'queued' (idempotente por el índice único de 0023).
//      Esto vive en la edge function (no en triggers) → honra la regla del BE, y al
//      ser state-driven no se puede saltear un evento (durable, no fire-and-forget).
//   B) DRENADO: procesa 'queued' + 'failed' (attempts<MAX), renderiza, "envía" (en
//      sandbox = dry-run), marca 'sent'/'failed'. El reintento es el mismo drenado.
//
// Decidido vía debate dual-Opus. service_role (createAdminClient) → puede escribir
// notification_log (que no tiene insert policy para authenticated).
// =============================================================================
import { createAdminClient } from "../_shared/supabaseAdmin.ts";
import { ok, unauthorized, serverError, preflight } from "../_shared/response.ts";
import { renderTemplate, type NotificationPayload } from "../_shared/notificationTemplates.ts";
import { sendWhatsApp } from "../_shared/whatsappTransport.ts";

const MAX_ATTEMPTS = 5;
const DRAIN_LIMIT = 100;

type Row = Record<string, unknown>;
const firstOf = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? v[0] ?? null : v ?? null;

// Inserta filas 'queued' para los candidatos que aún no tienen su notificación.
// Upsert ignore-duplicates sobre el índice de 0023 → idempotente y race-safe.
async function enqueueMissing(
  admin: ReturnType<typeof createAdminClient>,
  template: string,
  relatedType: string,
  rows: Array<{ id: string; shop_id: string; customer_id: string | null; payload: NotificationPayload }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const toInsert = rows.map((r) => ({
    shop_id: r.shop_id,
    customer_id: r.customer_id,
    channel: "whatsapp" as const,
    template,
    related_entity_type: relatedType,
    related_entity_id: r.id,
    payload: r.payload as unknown as Record<string, unknown>,
    status: "queued" as const,
  }));
  const { error } = await admin
    .from("notification_log")
    .upsert(toInsert, { onConflict: "related_entity_type,related_entity_id,template", ignoreDuplicates: true });
  if (error) throw error;
  return toInsert.length;
}

function woPayload(w: Row): NotificationPayload {
  const c = firstOf(w.customer as Row | Row[]);
  const v = firstOf(w.vehicle as Row | Row[]);
  return {
    customer_name: (c?.name as string) ?? null,
    whatsapp_number: (c?.whatsapp_number as string) ?? null,
    plate: (v?.plate as string) ?? null,
    make: (v?.make as string) ?? null,
    model: (v?.model as string) ?? null,
  } as NotificationPayload & { whatsapp_number: string | null };
}
function apptPayload(a: Row): NotificationPayload {
  const c = firstOf(a.customer as Row | Row[]);
  const v = firstOf(a.vehicle as Row | Row[]);
  return {
    customer_name: (c?.name as string) ?? null,
    whatsapp_number: (c?.whatsapp_number as string) ?? null,
    plate: (v?.plate as string) ?? null,
    make: (v?.make as string) ?? null,
    model: (v?.model as string) ?? null,
    scheduled_at: (a.scheduled_at as string) ?? null,
  } as NotificationPayload & { whatsapp_number: string | null };
}

async function sweep(admin: ReturnType<typeof createAdminClient>): Promise<number> {
  let enq = 0;
  const woSel = "id, shop_id, customer_id, status, customer:customers(name, whatsapp_number), vehicle:vehicles(plate, make, model)";
  const apSel = "id, shop_id, customer_id, scheduled_at, source, status, customer:customers(name, whatsapp_number), vehicle:vehicles(plate, make, model)";

  // vehicle_received: toda orden creada.
  {
    const { data } = await admin.from("work_orders").select(woSel);
    enq += await enqueueMissing(admin, "vehicle_received", "work_order",
      (data ?? []).map((w) => ({ id: w.id as string, shop_id: w.shop_id as string, customer_id: w.customer_id as string, payload: woPayload(w) })));
  }
  // vehicle_ready: orden que alcanzó (o pasó) 'delivery'.
  {
    const { data } = await admin.from("work_orders").select(woSel).in("status", ["delivery", "historical"]);
    enq += await enqueueMissing(admin, "vehicle_ready", "work_order",
      (data ?? []).map((w) => ({ id: w.id as string, shop_id: w.shop_id as string, customer_id: w.customer_id as string, payload: woPayload(w) })));
  }
  // delivery_completed: orden entregada (historical).
  {
    const { data } = await admin.from("work_orders").select(woSel).eq("status", "historical");
    enq += await enqueueMissing(admin, "delivery_completed", "work_order",
      (data ?? []).map((w) => ({ id: w.id as string, shop_id: w.shop_id as string, customer_id: w.customer_id as string, payload: woPayload(w) })));
  }
  // appointment_confirmed: cita originada en una cotización.
  {
    const { data } = await admin.from("appointments").select(apSel).eq("source", "quote");
    enq += await enqueueMissing(admin, "appointment_confirmed", "appointment",
      (data ?? []).map((a) => ({ id: a.id as string, shop_id: a.shop_id as string, customer_id: a.customer_id as string, payload: apptPayload(a) })));
  }
  // appointment_reminder_24h: citas en la ventana [now+23h, now+24h], activas.
  {
    const from = new Date(Date.now() + 23 * 3600_000).toISOString();
    const to = new Date(Date.now() + 24 * 3600_000).toISOString();
    const { data } = await admin.from("appointments").select(apSel)
      .gte("scheduled_at", from).lte("scheduled_at", to).in("status", ["scheduled", "confirmed"]);
    enq += await enqueueMissing(admin, "appointment_reminder_24h", "appointment",
      (data ?? []).map((a) => ({ id: a.id as string, shop_id: a.shop_id as string, customer_id: a.customer_id as string, payload: apptPayload(a) })));
  }
  return enq;
}

async function drain(admin: ReturnType<typeof createAdminClient>): Promise<{ sent: number; failed: number }> {
  const { data, error } = await admin
    .from("notification_log")
    .select("id, template, payload, attempts, status")
    .or(`status.eq.queued,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`)
    .order("created_at", { ascending: true })
    .limit(DRAIN_LIMIT);
  if (error) throw error;

  let sent = 0, failed = 0;
  for (const row of data ?? []) {
    const payload = (row.payload ?? {}) as NotificationPayload & { whatsapp_number?: string | null };
    const rendered = renderTemplate(row.template as string, payload);
    const attempts = (row.attempts as number) + 1;
    let res;
    if (!rendered) {
      res = { ok: false, dryRun: true, error: `plantilla desconocida: ${row.template}` };
    } else {
      res = await sendWhatsApp(payload.whatsapp_number ?? null, row.template as string, rendered);
    }
    if (res.ok) {
      await admin.from("notification_log").update({
        status: "sent", sent_at: new Date().toISOString(), attempts,
        payload: { ...payload, rendered: rendered?.text, dry_run: res.dryRun },
      }).eq("id", row.id as string);
      sent++;
    } else {
      await admin.from("notification_log").update({ status: "failed", attempts, error: res.error })
        .eq("id", row.id as string);
      failed++;
    }
  }
  return { sent, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return preflight();

  // Auth del invocador (cron/manual). Si CRON_SECRET está seteado, exige el header;
  // si no (dev local), permite — documentado: en prod CRON_SECRET DEBE estar seteado.
  const secret = Deno.env.get("CRON_SECRET");
  if (secret && req.headers.get("x-cron-secret") !== secret) {
    return unauthorized("x-cron-secret inválido");
  }

  try {
    const admin = createAdminClient();
    const enqueued = await sweep(admin);
    const { sent, failed } = await drain(admin);
    return ok({ enqueued, sent, failed });
  } catch (e) {
    const msg = e instanceof Error ? e.message
      : (e && typeof e === "object") ? JSON.stringify(e)
      : String(e);
    console.error("notification-dispatch error:", msg);
    return serverError(msg);
  }
});

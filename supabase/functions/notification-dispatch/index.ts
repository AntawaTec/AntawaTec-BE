// =============================================================================
// notification-dispatch — pipeline de notificaciones (RUNBOOK 3.8), SANDBOX.
//
// Invocada por cron (pg_cron+pg_net) o manualmente. Dos pasos por corrida:
//   A) BARRIDO state-driven: encuentra eventos del ciclo de vida sin su fila de
//      notificación y la inserta 'queued' (idempotente por el índice único de 0034).
//      Esto vive en la edge function (no en triggers) → honra la regla del BE, y al
//      ser state-driven no se puede saltear un evento (durable, no fire-and-forget).
//   B) DRENADO: procesa 'queued' + 'failed' (attempts<MAX), renderiza, "envía" (en
//      sandbox = dry-run), marca 'sent'/'failed'. El reintento es el mismo drenado.
//
// DOS CANALES: cada evento puede encolar una fila por canal (whatsapp y/o email) y
// el drenado bifurca por `channel`. El dedupe es por (entidad, plantilla, CANAL) —
// índice de 0034; el onConflict de abajo es su otra mitad, no se tocan por separado.
// Alcance del email v1: solo quote_ready y vehicle_received (los otros 4 eventos son
// avisos cortos y siguen whatsapp-only).
//
// Decidido vía debate dual-Opus. service_role (createAdminClient) → puede escribir
// notification_log (que no tiene insert policy para authenticated).
// =============================================================================
import { createAdminClient } from "../_shared/supabaseAdmin.ts";
import { ok, unauthorized, serverError, preflight } from "../_shared/response.ts";
import { renderTemplate, type NotificationPayload } from "../_shared/notificationTemplates.ts";
import { sendWhatsApp } from "../_shared/whatsappTransport.ts";
import {
  renderEmail,
  type EmailPayload,
  type QuoteSnapshot,
  type QuoteSnapshotSection,
} from "../_shared/emailTemplates.ts";
import { sendEmail } from "../_shared/emailTransport.ts";

const MAX_ATTEMPTS = 5;
const DRAIN_LIMIT = 100;
// Tope de ids por request en los filtros `.in(...)`: PostgREST los manda en la URL
// y una lista larga de UUIDs la desborda. Solo importa cuando el histórico crece.
const IN_CHUNK = 200;

type Row = Record<string, unknown>;
type Channel = "whatsapp" | "email";

const firstOf = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? v[0] ?? null : v ?? null;

function chunk<T>(arr: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Identidad del taller
// ---------------------------------------------------------------------------
// Una notificación tiene que decir DE QUÉ TALLER viene: los ~18 talleres comparten
// una WABA, un número y un dominio de correo, así que el remitente es genérico por
// construcción y la identidad solo puede viajar en el CONTENIDO (firma del WhatsApp,
// encabezado del email). Un solo select por corrida → Map en memoria: evaluado
// contra embeber shops en las 5+ queries del barrido, el mapa gana con ~18 filas.
interface ShopInfo {
  id: string;
  name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  logo_url: string | null;
  address: string | null;
}

async function loadShops(
  admin: ReturnType<typeof createAdminClient>,
): Promise<Map<string, ShopInfo>> {
  const { data, error } = await admin
    .from("shops")
    .select("id, name, contact_phone, contact_email, logo_url, address");
  if (error) throw error;
  const map = new Map<string, ShopInfo>();
  for (const s of data ?? []) map.set(s.id as string, s as unknown as ShopInfo);
  return map;
}

// Inserta filas 'queued' para los candidatos que aún no tienen su notificación.
// Upsert ignore-duplicates sobre el índice de 0034 → idempotente y race-safe. El
// onConflict DEBE incluir `channel` (si no, la fila de email choca con la de
// whatsapp del mismo evento y se descarta en silencio).
//
// Devuelve las filas REALMENTE insertadas, no los candidatos posteados: el
// `.select("id")` tras el upsert ignore-duplicates trae solo lo nuevo (ON CONFLICT
// DO NOTHING no retorna duplicados). De esto depende el Paso 0 del runbook —
// "repetir hasta enqueued: 0" — que con el conteo de candidatos jamás terminaría,
// porque los bloques whatsapp repostean todo el histórico en cada tick.
async function enqueueMissing(
  admin: ReturnType<typeof createAdminClient>,
  template: string,
  relatedType: string,
  rows: Array<{ id: string; shop_id: string; customer_id: string | null; payload: NotificationPayload }>,
  channel: Channel = "whatsapp",
): Promise<number> {
  if (rows.length === 0) return 0;
  const toInsert = rows.map((r) => ({
    shop_id: r.shop_id,
    customer_id: r.customer_id,
    channel,
    template,
    related_entity_type: relatedType,
    related_entity_id: r.id,
    payload: r.payload as unknown as Record<string, unknown>,
    status: "queued" as const,
  }));
  const { data, error } = await admin
    .from("notification_log")
    .upsert(toInsert, {
      onConflict: "related_entity_type,related_entity_id,template,channel",
      ignoreDuplicates: true,
    })
    .select("id");
  if (error) throw error;
  return data?.length ?? 0;
}

// Pre-filtro barato: qué eventos YA tienen fila, por canal. Existe para no pagar el
// fetch pesado del snapshot de la cotización en cada tick del cron: en régimen
// estacionario no falta ninguno y no se dispara ninguna query de detalle. NO es la
// garantía de unicidad — esa sigue siendo el upsert ignore-duplicates (race-safe).
async function existingByChannel(
  admin: ReturnType<typeof createAdminClient>,
  template: string,
  relatedType: string,
  ids: string[],
): Promise<{ whatsapp: Set<string>; email: Set<string> }> {
  const out = { whatsapp: new Set<string>(), email: new Set<string>() };
  for (const part of chunk(ids)) {
    const { data, error } = await admin
      .from("notification_log")
      .select("related_entity_id, channel")
      .eq("template", template)
      .eq("related_entity_type", relatedType)
      .in("related_entity_id", part);
    if (error) throw error;
    for (const r of data ?? []) {
      const id = r.related_entity_id as string;
      if ((r.channel as string) === "email") out.email.add(id);
      else out.whatsapp.add(id);
    }
  }
  return out;
}

// Snapshot de la cotización al momento de encolar. El correo debe reflejar EXACTO
// lo que el dueño envió: si edita la cotización después, lo ya encolado no cambia
// (y el drenado se mantiene puro, sin I/O de negocio). Se llama solo con los ids
// faltantes que detectó el pre-filtro.
async function loadQuoteSnapshots(
  admin: ReturnType<typeof createAdminClient>,
  quoteIds: string[],
): Promise<Map<string, QuoteSnapshot>> {
  const map = new Map<string, QuoteSnapshot>();
  const ids = [...new Set(quoteIds.filter(Boolean))];
  if (ids.length === 0) return map;

  for (const part of chunk(ids)) {
    const { data, error } = await admin
      .from("quotes")
      .select("id, quote_number, subtotal, tax, total")
      .in("id", part);
    if (error) throw error;
    for (const q of data ?? []) {
      map.set(q.id as string, {
        quote_number: (q.quote_number as number) ?? null,
        subtotal: (q.subtotal as number) ?? null,
        tax: (q.tax as number) ?? null,
        total: (q.total as number) ?? null,
        sections: [],
      });
    }
  }

  for (const part of chunk(ids)) {
    const { data, error } = await admin
      .from("quote_sections")
      .select("quote_id, section_type, subtotal, quote_items(description, quantity, unit_price, line_total)")
      .in("quote_id", part);
    if (error) throw error;
    for (const s of data ?? []) {
      const snap = map.get(s.quote_id as string);
      if (!snap) continue;
      const items = (s.quote_items ?? []) as Row[];
      const section: QuoteSnapshotSection = {
        section_type: (s.section_type as string) ?? null,
        subtotal: (s.subtotal as number) ?? null,
        items: items.map((it) => ({
          description: (it.description as string) ?? null,
          quantity: (it.quantity as number) ?? null,
          unit_price: (it.unit_price as number) ?? null,
          line_total: (it.line_total as number) ?? null,
        })),
      };
      snap.sections.push(section);
    }
  }
  return map;
}

const itemDescriptions = (snap: QuoteSnapshot | null): string[] =>
  (snap?.sections ?? []).flatMap((s) => (s.items ?? []).map((i) => i.description ?? "")).filter(Boolean);

// ---------------------------------------------------------------------------
// Payloads (snapshot que guarda el barrido; el render es puro y reproducible)
// ---------------------------------------------------------------------------
function shopFields(shop: ShopInfo | null): Pick<NotificationPayload, "shop_name" | "contact_phone"> {
  return { shop_name: shop?.name ?? null, contact_phone: shop?.contact_phone ?? null };
}

function shopEmailFields(shop: ShopInfo | null): Pick<EmailPayload, "contact_email" | "logo_url" | "address"> {
  return {
    contact_email: shop?.contact_email ?? null,
    logo_url: shop?.logo_url ?? null,
    address: shop?.address ?? null,
  };
}

function woPayload(w: Row, shop: ShopInfo | null): NotificationPayload {
  const c = firstOf(w.customer as Row | Row[]);
  const v = firstOf(w.vehicle as Row | Row[]);
  const d = firstOf(w.delivery as Row | Row[]);
  return {
    customer_name: (c?.name as string) ?? null,
    whatsapp_number: (c?.whatsapp_number as string) ?? null,
    plate: (v?.plate as string) ?? null,
    make: (v?.make as string) ?? null,
    model: (v?.model as string) ?? null,
    // CRUDO (multilínea, con viñetas): el aplanado a un parámetro válido de Meta lo
    // hace el render — el payload guarda el snapshot fiel de lo que escribió el taller.
    services_summary: (d?.services_summary as string) ?? null,
    ...shopFields(shop),
  } as NotificationPayload & { whatsapp_number: string | null };
}

function apptPayload(a: Row, shop: ShopInfo | null): NotificationPayload {
  const c = firstOf(a.customer as Row | Row[]);
  const v = firstOf(a.vehicle as Row | Row[]);
  return {
    customer_name: (c?.name as string) ?? null,
    whatsapp_number: (c?.whatsapp_number as string) ?? null,
    plate: (v?.plate as string) ?? null,
    make: (v?.make as string) ?? null,
    model: (v?.model as string) ?? null,
    scheduled_at: (a.scheduled_at as string) ?? null,
    ...shopFields(shop),
  } as NotificationPayload & { whatsapp_number: string | null };
}

function quotePayload(q: Row, shop: ShopInfo | null, snap: QuoteSnapshot | null): NotificationPayload {
  const c = firstOf(q.customer as Row | Row[]);
  const v = firstOf(q.vehicle as Row | Row[]);
  return {
    customer_name: (c?.name as string) ?? null,
    whatsapp_number: (c?.whatsapp_number as string) ?? null,
    plate: (v?.plate as string) ?? null,
    make: (v?.make as string) ?? null,
    model: (v?.model as string) ?? null,
    // Insumos del resumen corto del WhatsApp ({{3}} de quote_ready). Salen del MISMO
    // snapshot que el correo, así ambos canales cuentan la misma historia.
    quote_item_descriptions: itemDescriptions(snap),
    quote_total: (q.total as number) ?? null,
    ...shopFields(shop),
  } as NotificationPayload & { whatsapp_number: string | null };
}

function toEmailPayload(
  base: NotificationPayload,
  customer: Row | null,
  shop: ShopInfo | null,
  quote: QuoteSnapshot | null,
): EmailPayload {
  return {
    ...base,
    email: (customer?.email as string) ?? null,
    ...shopEmailFields(shop),
    quote,
  };
}

// ---------------------------------------------------------------------------
// Barrido
// ---------------------------------------------------------------------------
async function sweep(admin: ReturnType<typeof createAdminClient>): Promise<number> {
  let enq = 0;
  const shops = await loadShops(admin);
  const shopOf = (id: unknown) => shops.get(id as string) ?? null;

  const woSel =
    "id, shop_id, customer_id, status, quote_id, customer:customers(name, whatsapp_number, email), vehicle:vehicles(plate, make, model)";
  const apSel =
    "id, shop_id, customer_id, scheduled_at, source, status, customer:customers(name, whatsapp_number), vehicle:vehicles(plate, make, model)";
  const qtSel =
    "id, shop_id, customer_id, quote_number, total, sent_at, customer:customers(name, whatsapp_number, email), vehicle:vehicles(plate, make, model)";

  // vehicle_received: toda orden creada. WhatsApp para todas + email (alcance v1)
  // con el detalle de los trabajos acordados cuando la orden nace de una cotización.
  {
    const { data } = await admin.from("work_orders").select(woSel);
    const rows = (data ?? []) as Row[];
    enq += await enqueueMissing(admin, "vehicle_received", "work_order",
      rows.map((w) => ({ id: w.id as string, shop_id: w.shop_id as string, customer_id: w.customer_id as string, payload: woPayload(w, shopOf(w.shop_id)) })));

    if (rows.length > 0) {
      const existing = await existingByChannel(admin, "vehicle_received", "work_order", rows.map((w) => w.id as string));
      const missing = rows.filter((w) => !existing.email.has(w.id as string));
      // Solo los faltantes CON cotización enlazada pagan el fetch del snapshot.
      const snaps = await loadQuoteSnapshots(admin, missing.map((w) => w.quote_id as string).filter(Boolean));
      enq += await enqueueMissing(admin, "vehicle_received", "work_order",
        missing.map((w) => {
          const shop = shopOf(w.shop_id);
          const quote = w.quote_id ? snaps.get(w.quote_id as string) ?? null : null;
          return {
            id: w.id as string,
            shop_id: w.shop_id as string,
            customer_id: w.customer_id as string,
            payload: toEmailPayload(woPayload(w, shop), firstOf(w.customer as Row | Row[]), shop, quote),
          };
        }), "email");
    }
  }
  // vehicle_ready: orden que alcanzó (o pasó) 'delivery'.
  {
    const { data } = await admin.from("work_orders").select(woSel).in("status", ["delivery", "historical"]);
    enq += await enqueueMissing(admin, "vehicle_ready", "work_order",
      (data ?? []).map((w) => ({ id: w.id as string, shop_id: w.shop_id as string, customer_id: w.customer_id as string, payload: woPayload(w, shopOf(w.shop_id)) })));
  }
  // delivery_completed: orden entregada (historical). El embed 1:1 con la entrega
  // (work_order_deliveries.work_order_id es UNIQUE) trae el resumen que el taller
  // escribió al entregar; el cierre rápido lo deja NULL y el render usa su fallback.
  {
    const { data } = await admin.from("work_orders")
      .select(`${woSel}, delivery:work_order_deliveries(services_summary)`)
      .eq("status", "historical");
    enq += await enqueueMissing(admin, "delivery_completed", "work_order",
      (data ?? []).map((w) => ({ id: w.id as string, shop_id: w.shop_id as string, customer_id: w.customer_id as string, payload: woPayload(w, shopOf(w.shop_id)) })));
  }
  // appointment_confirmed: cita originada en una cotización.
  {
    const { data } = await admin.from("appointments").select(apSel).eq("source", "quote");
    enq += await enqueueMissing(admin, "appointment_confirmed", "appointment",
      (data ?? []).map((a) => ({ id: a.id as string, shop_id: a.shop_id as string, customer_id: a.customer_id as string, payload: apptPayload(a, shopOf(a.shop_id)) })));
  }
  // appointment_reminder_24h: citas en la ventana [now+23h, now+24h], activas.
  {
    const from = new Date(Date.now() + 23 * 3600_000).toISOString();
    const to = new Date(Date.now() + 24 * 3600_000).toISOString();
    const { data } = await admin.from("appointments").select(apSel)
      .gte("scheduled_at", from).lte("scheduled_at", to).in("status", ["scheduled", "confirmed"]);
    enq += await enqueueMissing(admin, "appointment_reminder_24h", "appointment",
      (data ?? []).map((a) => ({ id: a.id as string, shop_id: a.shop_id as string, customer_id: a.customer_id as string, payload: apptPayload(a, shopOf(a.shop_id)) })));
  }
  // quote_ready: cotización que el dueño marcó como enviada al cliente (0033).
  // sent_at nace NULL en todas las filas existentes → este evento NO arrastra
  // backlog histórico. Ambos canales necesitan el snapshot (el WhatsApp para su
  // línea de resumen, el correo para el desglose), así que el pre-filtro de
  // faltantes cubre a los dos.
  {
    const { data } = await admin.from("quotes").select(qtSel).not("sent_at", "is", null);
    const rows = (data ?? []) as Row[];
    if (rows.length > 0) {
      const ids = rows.map((q) => q.id as string);
      const existing = await existingByChannel(admin, "quote_ready", "quote", ids);
      const missing = ids.filter((id) => !existing.whatsapp.has(id) || !existing.email.has(id));
      const snaps = await loadQuoteSnapshots(admin, missing);

      const wa = rows.filter((q) => !existing.whatsapp.has(q.id as string));
      enq += await enqueueMissing(admin, "quote_ready", "quote",
        wa.map((q) => ({
          id: q.id as string,
          shop_id: q.shop_id as string,
          customer_id: q.customer_id as string,
          payload: quotePayload(q, shopOf(q.shop_id), snaps.get(q.id as string) ?? null),
        })));

      const mail = rows.filter((q) => !existing.email.has(q.id as string));
      enq += await enqueueMissing(admin, "quote_ready", "quote",
        mail.map((q) => {
          const shop = shopOf(q.shop_id);
          const snap = snaps.get(q.id as string) ?? null;
          return {
            id: q.id as string,
            shop_id: q.shop_id as string,
            customer_id: q.customer_id as string,
            payload: toEmailPayload(quotePayload(q, shop, snap), firstOf(q.customer as Row | Row[]), shop, snap),
          };
        }), "email");
    }
  }
  return enq;
}

// ---------------------------------------------------------------------------
// Drenado
// ---------------------------------------------------------------------------
async function drain(admin: ReturnType<typeof createAdminClient>): Promise<{ sent: number; failed: number }> {
  const { data, error } = await admin
    .from("notification_log")
    .select("id, template, channel, payload, attempts, status")
    .or(`status.eq.queued,and(status.eq.failed,attempts.lt.${MAX_ATTEMPTS})`)
    .order("created_at", { ascending: true })
    .limit(DRAIN_LIMIT);
  if (error) throw error;

  let sent = 0, failed = 0;
  for (const row of data ?? []) {
    const attempts = (row.attempts as number) + 1;
    let res: { ok: boolean; dryRun: boolean; error?: string };
    // Lo que queda en payload.rendered: el texto del WhatsApp o el SUBJECT del
    // correo (no el HTML — es reproducible desde el snapshot y no vale inflar la
    // fila del log con 6 KB de tablas).
    let rendered: string | undefined;

    if ((row.channel as string) === "email") {
      const payload = (row.payload ?? {}) as EmailPayload;
      const mail = renderEmail(row.template as string, payload);
      if (!mail) {
        res = { ok: false, dryRun: true, error: `plantilla sin correo: ${row.template}` };
      } else {
        rendered = mail.subject;
        res = await sendEmail(payload.email ?? null, mail.subject, mail.html, {
          fromName: payload.shop_name ?? "AntawaTec",
          replyTo: payload.contact_email ?? null,
        });
      }
    } else {
      const payload = (row.payload ?? {}) as NotificationPayload & { whatsapp_number?: string | null };
      const out = renderTemplate(row.template as string, payload);
      if (!out) {
        res = { ok: false, dryRun: true, error: `plantilla desconocida: ${row.template}` };
      } else {
        rendered = out.text;
        res = await sendWhatsApp(payload.whatsapp_number ?? null, row.template as string, out);
      }
    }

    if (res.ok) {
      const payload = (row.payload ?? {}) as Record<string, unknown>;
      await admin.from("notification_log").update({
        status: "sent", sent_at: new Date().toISOString(), attempts,
        payload: { ...payload, rendered, dry_run: res.dryRun },
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

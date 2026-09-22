// =============================================================================
// _shared/orderSnapshot.ts
// La pata de I/O del PDF: arma el `OrderPdfSnapshot` leyendo la orden FRESCA de
// la base (service_role, sin RLS) y baja el logo del taller.
//
// Por qué FRESCA y no el snapshot del payload, al revés que el correo de
// cotización: el payload de `notification_log` congela lo que el cliente recibió
// (regla del pipeline), pero esos documentos NO son el aviso — son el acta de lo
// que hay en la orden. Entre el encolado y el envío el taller sigue cargando
// repuestos, trabajos y el resumen de entrega; adjuntar la foto del encolado
// mandaría un PDF a medio llenar. El HOLD de 15 minutos del drenado existe para
// darle ese margen (ver notification-dispatch/index.ts).
//
// Una sola query a `work_orders` con embeds resuelve cliente, vehículo, técnico,
// consumos, entrega y cotización enlazada. La cotización se embebe por el FK
// COMPUESTO `work_orders_quote_fk (quote_id, shop_id) → quotes(id, shop_id)`, y
// se nombra explícitamente el constraint para que PostgREST no tenga que
// adivinar la relación.
// =============================================================================

import type { createAdminClient } from "./supabaseAdmin.ts";
import {
  summarizeSelections,
  type CatalogItem,
  type CatalogModule,
  type CatalogSelection,
  type ModuleComments,
} from "./catalogSummary.ts";
import { detectLogoKind, type LogoImage, type OrderPdfSnapshot, type OrderPdfPart } from "./orderPdf.ts";

type Admin = ReturnType<typeof createAdminClient>;
type Row = Record<string, unknown>;

const firstOf = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? v[0] ?? null : v ?? null;

/**
 * Cache del catálogo por CORRIDA del dispatcher. `catalog_items` son ~250 filas
 * globales e inmutables dentro de un tick; con PDF_PER_TICK=8 esto ahorra 7
 * lecturas por minuto sin arriesgar datos viejos entre corridas.
 */
export interface CatalogCache {
  items: CatalogItem[] | null;
}

export function createCatalogCache(): CatalogCache {
  return { items: null };
}

const ORDER_SELECT = `
  id, shop_id, order_number, status, created_at, mileage_in, fuel_level, estimated_total, checklist,
  customer:customers(name),
  vehicle:vehicles(plate, make, model, year),
  technician:technicians(full_name),
  movements:inventory_movements(quantity, product:products(name, uom)),
  delivery:work_order_deliveries(delivered_at, final_mileage, services_summary, future_maintenance),
  quote:quotes!work_orders_quote_fk(quote_number, status, total)
`.replace(/\s+/g, " ").trim();

async function loadCatalogItems(admin: Admin, cache?: CatalogCache): Promise<CatalogItem[]> {
  if (cache?.items) return cache.items;
  const { data, error } = await admin
    .from("catalog_items")
    .select("id, module, parent_id, name, selection_type, enum_options, sort_order")
    .order("sort_order");
  if (error) throw error;
  const items = (data ?? []) as unknown as CatalogItem[];
  if (cache) cache.items = items;
  return items;
}

/**
 * Comentarios por módulo (`work_order_module_comments`, migración 0039).
 *
 * TOLERANTE A PROPÓSITO: esa tabla la agrega otro lote en paralelo, así que
 * puede no existir todavía en el proyecto donde corre esta función. Un error de
 * lectura (42P01 tabla inexistente, PGRST205 tabla no expuesta, o cualquier
 * otro) se trata como "sin comentarios" — el PDF sale igual, sin ese bloque. No
 * vale tumbar un correo por una sección opcional.
 */
async function loadModuleComments(admin: Admin, workOrderId: string): Promise<ModuleComments> {
  const out: ModuleComments = {};
  try {
    const { data, error } = await admin
      .from("work_order_module_comments")
      .select("module, comment")
      .eq("work_order_id", workOrderId);
    if (error) {
      console.warn(`orderSnapshot: sin comentarios por módulo (${error.message})`);
      return out;
    }
    for (const r of (data ?? []) as Row[]) {
      const mod = r.module as CatalogModule | null;
      const comment = (r.comment as string | null) ?? "";
      if (mod && comment) out[mod] = comment;
    }
  } catch (e) {
    console.warn("orderSnapshot: sin comentarios por módulo:", e instanceof Error ? e.message : String(e));
  }
  return out;
}

/**
 * Snapshot completo para el PDF. Devuelve null si la orden no existe (fila
 * borrada entre el encolado y el envío) — el dispatcher lo marca `failed`.
 */
export async function loadOrderPdfSnapshot(
  admin: Admin,
  workOrderId: string,
  catalogCache?: CatalogCache,
): Promise<OrderPdfSnapshot | null> {
  const { data, error } = await admin
    .from("work_orders")
    .select(ORDER_SELECT)
    .eq("id", workOrderId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const w = data as unknown as Row;

  const { data: shopRow, error: shopErr } = await admin
    .from("shops")
    .select("name, address, contact_phone, logo_url")
    .eq("id", w.shop_id as string)
    .maybeSingle();
  if (shopErr) throw shopErr;

  const { data: selRows, error: selErr } = await admin
    .from("work_order_catalog_selections")
    .select("catalog_item_id, selected_value, notes")
    .eq("work_order_id", workOrderId);
  if (selErr) throw selErr;
  const selections = (selRows ?? []) as unknown as CatalogSelection[];

  const comments = await loadModuleComments(admin, workOrderId);
  // El catálogo solo hace falta si hay algo que resumir.
  const needsCatalog = selections.length > 0 || Object.keys(comments).length > 0;
  const items = needsCatalog ? await loadCatalogItems(admin, catalogCache) : [];

  // Solo CONSUMOS: la convención de 0008 es cantidad con signo (compra +,
  // consumo −). El documento del cliente muestra el valor absoluto.
  const parts: OrderPdfPart[] = ((w.movements ?? []) as Row[])
    .filter((m) => typeof m.quantity === "number" && (m.quantity as number) < 0)
    .map((m) => {
      const p = firstOf(m.product as Row | Row[]);
      return {
        name: (p?.name as string) ?? null,
        uom: (p?.uom as string) ?? null,
        quantity: m.quantity as number,
      };
    });

  const delivery = firstOf(w.delivery as Row | Row[]);
  const quote = firstOf(w.quote as Row | Row[]);
  const shop = (shopRow ?? {}) as Row;

  return {
    shop: {
      name: (shop.name as string) ?? null,
      address: (shop.address as string) ?? null,
      contact_phone: (shop.contact_phone as string) ?? null,
      logo_url: (shop.logo_url as string) ?? null,
    },
    order: {
      id: w.id as string,
      order_number: (w.order_number as number) ?? 0,
      status: (w.status as string) ?? "reception",
      created_at: (w.created_at as string) ?? null,
      mileage_in: (w.mileage_in as number) ?? null,
      fuel_level: (w.fuel_level as string) ?? null,
      estimated_total: (w.estimated_total as number) ?? null,
      checklist: (w.checklist as OrderPdfSnapshot["order"]["checklist"]) ?? null,
    },
    customer: { name: (firstOf(w.customer as Row | Row[])?.name as string) ?? null },
    vehicle: (() => {
      const v = firstOf(w.vehicle as Row | Row[]);
      if (!v) return null;
      return {
        plate: (v.plate as string) ?? null,
        make: (v.make as string) ?? null,
        model: (v.model as string) ?? null,
        year: (v.year as number) ?? null,
      };
    })(),
    technician: (() => {
      const t = firstOf(w.technician as Row | Row[]);
      return t ? { full_name: (t.full_name as string) ?? null } : null;
    })(),
    catalog_summary: needsCatalog ? summarizeSelections(items, selections, comments) : "",
    linked_quote: quote
      ? {
        quote_number: (quote.quote_number as number) ?? null,
        status: (quote.status as string) ?? null,
        total: (quote.total as number) ?? null,
      }
      : null,
    parts,
    delivery: delivery
      ? {
        delivered_at: (delivery.delivered_at as string) ?? null,
        final_mileage: (delivery.final_mileage as number) ?? null,
        services_summary: (delivery.services_summary as string) ?? null,
        future_maintenance: (delivery.future_maintenance as string) ?? null,
      }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

export interface FetchLogoOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

/**
 * Baja el logo del taller (bucket público `shop-logos`) para embeberlo en el
 * PDF. BEST-EFFORT en todos sus modos de falla — URL vacía, timeout, 404,
 * archivo gigante o formato que pdf-lib no embebe (webp es el caso típico: el
 * FE sube preferentemente webp). Cualquiera de esos devuelve null y el
 * documento sale sin logo. Nunca lanza.
 */
export async function fetchLogo(
  url: string | null | undefined,
  opts: FetchLogoOptions = {},
): Promise<LogoImage | null> {
  const src = (url ?? "").trim();
  if (!src) return null;
  const timeoutMs = opts.timeoutMs ?? 3000;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(src, { signal: ctrl.signal });
    if (!res.ok) {
      console.warn(`fetchLogo: ${res.status} en ${src}`);
      return null;
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      console.warn(`fetchLogo: logo de ${declared} bytes supera el tope`);
      await res.body?.cancel();
      return null;
    }
    // Lectura acotada: el content-length puede faltar o mentir.
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    if (!reader) return null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        console.warn("fetchLogo: el logo supera el tope de bytes");
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    const kind = detectLogoKind(bytes);
    if (!kind) {
      // webp / svg / basura: pdf-lib solo embebe PNG y JPEG.
      console.warn("fetchLogo: formato no embebible (se omite el logo)");
      return null;
    }
    return { bytes, kind };
  } catch (e) {
    console.warn("fetchLogo:", e instanceof Error ? e.message : String(e));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

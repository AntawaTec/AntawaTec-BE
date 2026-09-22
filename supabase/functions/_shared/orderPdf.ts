// =============================================================================
// _shared/orderPdf.ts
// Generación server-side de los DOS documentos que el cliente final recibe por
// correo: la **orden de trabajo** (recepción) y el **recibo de entrega**.
// PURO: entra un snapshot (+ opcionalmente el logo ya descargado) y sale un PDF.
// Nada de red ni de base — el I/O vive en orderSnapshot.ts.
//
// Son el ESPEJO de las vistas imprimibles del FE:
//   AntawaTec-FE/src/components/ordenes/OrderPrintView.tsx      → renderOrderPdf
//   AntawaTec-FE/src/components/ordenes/DeliveryReceiptView.tsx → renderDeliveryReceiptPdf
// Mismo contenido, mismo orden de bloques, mismas omisiones deliberadas: SIN
// costos de repuestos (`unit_cost` es el costo interno del taller, no el precio
// al cliente) y sin código de alarma. El descargo de responsabilidad va SOLO en
// la orden (se firma al recibir el vehículo), nunca en el recibo.
//
// Tres restricciones del motor que condicionan todo el archivo:
//
//  1. FUENTES. Usamos las Standard 14 (Helvetica / Helvetica-Bold) para no
//     embeber ~300 KB de TTF en cada adjunto. Esas fuentes codifican en WinAnsi
//     y pdf-lib TIRA EXCEPCIÓN ante un carácter fuera del set. El texto que
//     entra acá es texto libre tipeado en la PWA (nombres, notas, resúmenes):
//     un emoji en una nota rompería el correo entero. De ahí que TODO string
//     pase por `sanitize()` — NFC + filtro contra `font.getCharacterSet()` —
//     antes de tocar `drawText`. Las tildes y la "ñ" SÍ están en WinAnsi; "→",
//     "✓" y los emoji no (se reemplazan por "?").
//
//  2. NO HAY LAYOUT ENGINE. pdf-lib dibuja en coordenadas absolutas, así que el
//     archivo trae su propio word-wrap (`wrapText` + `widthOfTextAtSize`) y su
//     propia paginación (cursor `y` + `needRoom()` antes de cada bloque).
//
//  3. IMÁGENES. pdf-lib solo embebe PNG y JPEG. El logo del taller puede ser
//     webp (el FE sube preferentemente webp), así que el tipo se decide por
//     MAGIC BYTES y lo que no sea PNG/JPEG se omite — el documento sale igual,
//     sin logo. Ver `detectLogoKind()`.
// =============================================================================

import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import type { PDFFont, PDFPage, RGB } from "npm:pdf-lib@1.17.1";
import { money } from "./emailTemplates.ts";
import { LIABILITY_DISCLAIMER } from "./legal.ts";

// ---------------------------------------------------------------------------
// Contrato de datos (lo llena orderSnapshot.ts)
// ---------------------------------------------------------------------------

export interface OrderPdfShop {
  name: string | null;
  address: string | null;
  contact_phone: string | null;
  /** Extra al contrato mínimo: lo consume el dispatcher para bajar el logo. */
  logo_url?: string | null;
}

/** Inventario de ingreso: `work_orders.checklist` (jsonb libre del FE). */
export interface OrderPdfChecklist {
  items?: { label?: string | null; checked?: boolean | null }[] | null;
  notes?: string | null;
}

export interface OrderPdfOrder {
  id: string;
  order_number: number;
  status: string;
  created_at: string | null;
  mileage_in: number | null;
  fuel_level: string | null;
  estimated_total: number | null;
  checklist: OrderPdfChecklist | null;
}

export interface OrderPdfCustomer {
  name: string | null;
}

export interface OrderPdfVehicle {
  plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
}

export interface OrderPdfTechnician {
  full_name: string | null;
}

/** Repuesto consumido. SIN `unit_cost` a propósito (ver cabecera). */
export interface OrderPdfPart {
  name: string | null;
  uom: string | null;
  quantity: number;
}

export interface OrderPdfQuote {
  quote_number: number | null;
  status: string | null;
  total: number | null;
}

export interface OrderPdfDelivery {
  delivered_at: string | null;
  final_mileage: number | null;
  services_summary: string | null;
  future_maintenance: string | null;
}

export interface OrderPdfSnapshot {
  shop: OrderPdfShop;
  order: OrderPdfOrder;
  customer: OrderPdfCustomer | null;
  vehicle: OrderPdfVehicle | null;
  technician: OrderPdfTechnician | null;
  /** Texto plano multilínea de catalogSummary.summarizeSelections(). */
  catalog_summary: string;
  linked_quote: OrderPdfQuote | null;
  parts: OrderPdfPart[];
  delivery: OrderPdfDelivery | null;
}

/** Logo YA descargado y ya validado como raster embebible. */
export interface LogoImage {
  bytes: Uint8Array;
  kind: "png" | "jpg";
}

// ---------------------------------------------------------------------------
// Estilo (espeja los tokens del FE: #111827 / #6b7280 / #e5e7eb)
// ---------------------------------------------------------------------------

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 48;
const BOTTOM = 52;
const CONTENT_W = PAGE_W - MARGIN * 2;
const HEADER_LEFT_W = 300;

const INK: RGB = rgb(0.067, 0.094, 0.153);
const MUTED: RGB = rgb(0.42, 0.447, 0.502);
const HAIRLINE: RGB = rgb(0.898, 0.906, 0.922);

// Espejo de STATUS_LABELS (AntawaTec-FE/src/lib/data/workOrders.ts).
const STATUS_LABELS: Record<string, string> = {
  reception: "Recepción",
  quote: "Cotización",
  in_process: "En proceso",
  delivery: "Entrega",
  historical: "Histórico",
};

// Espejo de QUOTE_STATUS_META (AntawaTec-FE/src/lib/data/quotes.ts).
const QUOTE_STATUS_LABELS: Record<string, string> = {
  draft: "Borrador",
  approved: "Aprobada",
  rejected: "Rechazada",
};

// ---------------------------------------------------------------------------
// Formateo (sin depender del locale del runtime más de lo necesario)
// ---------------------------------------------------------------------------

/** Espejo de formatOrderNumber() del FE: "OT-0042". */
export function formatOrderNumber(n: number | null | undefined): string {
  return `OT-${String(typeof n === "number" ? n : 0).padStart(4, "0")}`;
}

/** Espejo de formatQuoteNumber() del FE: "N° 0042". */
function formatQuoteNumber(n: number | null | undefined): string {
  return `N° ${String(typeof n === "number" ? n : 0).padStart(4, "0")}`;
}

// Ecuador no tiene horario de verano: el offset es fijo -05:00. Se computa a
// mano (y no con Intl + timeZone) para que el documento salga idéntico corra
// donde corra, incluso en un runtime sin ICU completo.
const EC_OFFSET_MS = -5 * 3600_000;

function ecParts(iso: string | null | undefined) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t + EC_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`,
    time: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`,
  };
}

function fmtDate(iso: string | null | undefined): string {
  return ecParts(iso)?.date ?? "—";
}

function fmtDateTime(iso: string | null | undefined): string {
  const p = ecParts(iso);
  return p ? `${p.date} ${p.time}` : "—";
}

/** Entero con separador de miles es-EC ("12.500"). */
function num(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  try {
    return n.toLocaleString("es-EC", { maximumFractionDigits: 2 });
  } catch {
    return String(n);
  }
}

function vehicleLabel(v: OrderPdfVehicle | null): string {
  if (!v) return "—";
  const mm = [v.make, v.model].filter(Boolean).join(" ");
  const parts = [v.plate ?? "—", mm || null, v.year ? String(v.year) : null].filter(Boolean);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Saneado de texto (ver punto 1 de la cabecera)
// ---------------------------------------------------------------------------

// Invisibles que no aportan nada al PDF y que NO queremos ver como "?".
const DROPPED = new Set([0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0xfeff]);

/**
 * Filtro WinAnsi. EXPORTADO para poder testearlo aparte: es la pieza que decide
 * si un emoji en una nota rompe el correo o sale como "?".
 */
export function sanitizeForCharset(charset: Set<number>, raw: unknown): string {
  const s = String(raw ?? "").normalize("NFC");
  let out = "";
  for (const ch of s) {
    if (ch === "\n") {
      out += "\n";
      continue;
    }
    if (ch === "\r") continue;
    if (ch === "\t") {
      out += " ";
      continue;
    }
    const cp = ch.codePointAt(0)!;
    // Variation selectors (los que acompañan a los emoji) y otros invisibles.
    if (DROPPED.has(cp) || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    out += charset.has(cp) ? ch : "?";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Motor de layout mínimo
// ---------------------------------------------------------------------------

interface Ctx {
  doc: PDFDocument;
  page: PDFPage;
  y: number;
  font: PDFFont;
  bold: PDFFont;
  charset: Set<number>;
}

function newPage(ctx: Ctx): void {
  ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
  ctx.y = PAGE_H - MARGIN;
}

function needRoom(ctx: Ctx, height: number): void {
  if (ctx.y - height < BOTTOM) newPage(ctx);
}

function splitLongWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  if (maxWidth <= 0 || font.widthOfTextAtSize(word, size) <= maxWidth) return [word];
  const parts: string[] = [];
  let cur = "";
  for (const ch of word) {
    const cand = cur + ch;
    if (cur && font.widthOfTextAtSize(cand, size) > maxWidth) {
      parts.push(cur);
      cur = ch;
    } else {
      cur = cand;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

/**
 * Word-wrap propio. Respeta los saltos de línea del texto y la SANGRÍA inicial
 * de cada línea (el resumen del catálogo usa 2 espacios para notas y
 * comentarios; perderla haría ilegible el bloque "Trabajos").
 */
function wrapText(raw: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const rawLine of raw.split("\n")) {
    const indent = /^ */.exec(rawLine)?.[0] ?? "";
    const indentW = font.widthOfTextAtSize(indent, size);
    const words = rawLine.slice(indent.length).split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      out.push("");
      continue;
    }
    let line = "";
    for (const word of words) {
      for (const piece of splitLongWord(word, font, size, maxWidth - indentW)) {
        const cand = line ? `${line} ${piece}` : piece;
        if (line && indentW + font.widthOfTextAtSize(cand, size) > maxWidth) {
          out.push(indent + line);
          line = piece;
        } else {
          line = cand;
        }
      }
    }
    if (line) out.push(indent + line);
  }
  return out;
}

/** Recorta a UNA línea (celdas de grilla / columnas angostas). */
function fitOneLine(ctx: Ctx, raw: string, font: PDFFont, size: number, maxWidth: number): string {
  const text = sanitizeForCharset(ctx.charset, raw).replace(/\n/g, " ");
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cur = "";
  for (const ch of text) {
    if (font.widthOfTextAtSize(`${cur}${ch}...`, size) > maxWidth) break;
    cur += ch;
  }
  return `${cur.trimEnd()}...`;
}

interface TextOpts {
  size?: number;
  bold?: boolean;
  color?: RGB;
  x?: number;
  width?: number;
  gapAfter?: number;
  lineHeight?: number;
}

/** Dibuja texto ya saneado en coordenadas absolutas (no mueve el cursor). */
function drawAt(ctx: Ctx, text: string, x: number, y: number, opts: TextOpts = {}): void {
  if (!text) return;
  ctx.page.drawText(text, {
    x,
    y,
    size: opts.size ?? 10,
    font: opts.bold ? ctx.bold : ctx.font,
    color: opts.color ?? INK,
  });
}

/** Párrafo con wrap + paginación. Mueve el cursor. */
function para(ctx: Ctx, raw: string, opts: TextOpts = {}): void {
  const size = opts.size ?? 10;
  const font = opts.bold ? ctx.bold : ctx.font;
  const x = opts.x ?? MARGIN;
  const width = opts.width ?? CONTENT_W;
  const lh = opts.lineHeight ?? size * 1.38;
  const lines = wrapText(sanitizeForCharset(ctx.charset, raw), font, size, width);
  for (const line of lines) {
    needRoom(ctx, lh);
    ctx.y -= lh;
    drawAt(ctx, line, x, ctx.y, opts);
  }
  if (opts.gapAfter) ctx.y -= opts.gapAfter;
}

function hr(ctx: Ctx, gapBefore = 8, gapAfter = 12): void {
  needRoom(ctx, gapBefore + gapAfter + 1);
  ctx.y -= gapBefore;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: MARGIN + CONTENT_W, y: ctx.y },
    thickness: 0.7,
    color: HAIRLINE,
  });
  ctx.y -= gapAfter;
}

function sectionTitle(ctx: Ctx, title: string): void {
  needRoom(ctx, 34);
  para(ctx, title, { size: 11.5, bold: true, gapAfter: 4 });
}

/** Grilla de hechos en N columnas: label chico arriba, valor en negrita abajo. */
function factsGrid(ctx: Ctx, cells: { label: string; value: string }[], cols = 4): void {
  const colW = CONTENT_W / cols;
  const rowH = 30;
  for (let i = 0; i < cells.length; i += cols) {
    needRoom(ctx, rowH);
    const top = ctx.y;
    cells.slice(i, i + cols).forEach((cell, j) => {
      const x = MARGIN + j * colW;
      drawAt(ctx, fitOneLine(ctx, cell.label, ctx.font, 8, colW - 8), x, top - 9, {
        size: 8,
        color: MUTED,
      });
      drawAt(ctx, fitOneLine(ctx, cell.value, ctx.bold, 10.5, colW - 8), x, top - 22, {
        size: 10.5,
        bold: true,
      });
    });
    ctx.y = top - rowH;
  }
}

/** Dos columnas "label / valor" (Cliente · Vehículo). */
function twoUp(ctx: Ctx, left: { label: string; value: string }, right: { label: string; value: string }): void {
  const colW = CONTENT_W / 2;
  needRoom(ctx, 32);
  const top = ctx.y;
  [left, right].forEach((cell, j) => {
    const x = MARGIN + j * colW;
    drawAt(ctx, fitOneLine(ctx, cell.label, ctx.font, 8, colW - 8), x, top - 9, {
      size: 8,
      color: MUTED,
    });
    drawAt(ctx, fitOneLine(ctx, cell.value, ctx.bold, 10.5, colW - 8), x, top - 22, {
      size: 10.5,
      bold: true,
    });
  });
  ctx.y = top - 32;
}

/** Tabla de repuestos: descripción (wrap) + cantidad alineada a la derecha. */
function partsTable(ctx: Ctx, parts: OrderPdfPart[]): void {
  const qtyW = 110;
  const descW = CONTENT_W - qtyW - 8;
  const rightEdge = MARGIN + CONTENT_W;

  needRoom(ctx, 26);
  ctx.y -= 12;
  drawAt(ctx, "DESCRIPCIÓN", MARGIN, ctx.y, { size: 8, color: MUTED });
  const headQty = "CANTIDAD";
  drawAt(ctx, headQty, rightEdge - ctx.font.widthOfTextAtSize(headQty, 8), ctx.y, {
    size: 8,
    color: MUTED,
  });
  ctx.y -= 5;
  ctx.page.drawLine({
    start: { x: MARGIN, y: ctx.y },
    end: { x: rightEdge, y: ctx.y },
    thickness: 1,
    color: HAIRLINE,
  });

  for (const part of parts) {
    const lines = wrapText(sanitizeForCharset(ctx.charset, part.name ?? "—"), ctx.font, 10, descW);
    const rowH = Math.max(lines.length * 13, 13) + 8;
    needRoom(ctx, rowH);
    const top = ctx.y;
    lines.forEach((line, i) => drawAt(ctx, line, MARGIN, top - 13 - i * 13, { size: 10 }));
    const qty = `${num(Math.abs(part.quantity))}${part.uom ? ` ${part.uom}` : ""}`;
    const qtyText = fitOneLine(ctx, qty, ctx.font, 10, qtyW);
    drawAt(ctx, qtyText, rightEdge - ctx.font.widthOfTextAtSize(qtyText, 10), top - 13, { size: 10 });
    ctx.y = top - rowH;
    ctx.page.drawLine({
      start: { x: MARGIN, y: ctx.y + 4 },
      end: { x: rightEdge, y: ctx.y + 4 },
      thickness: 0.5,
      color: HAIRLINE,
    });
  }
}

/** Línea de firma alineada a la derecha, con leyenda y nombre del cliente. */
function signatureBlock(ctx: Ctx, caption: string, name: string): void {
  const boxW = 240;
  needRoom(ctx, 74);
  ctx.y -= 46;
  const x = MARGIN + CONTENT_W - boxW;
  ctx.page.drawLine({
    start: { x, y: ctx.y },
    end: { x: x + boxW, y: ctx.y },
    thickness: 0.8,
    color: INK,
  });
  ctx.y -= 12;
  const cap = fitOneLine(ctx, caption, ctx.font, 8.5, boxW);
  drawAt(ctx, cap, x + (boxW - ctx.font.widthOfTextAtSize(cap, 8.5)) / 2, ctx.y, {
    size: 8.5,
    color: MUTED,
  });
  if (name) {
    ctx.y -= 13;
    const nm = fitOneLine(ctx, name, ctx.bold, 10, boxW);
    drawAt(ctx, nm, x + (boxW - ctx.bold.widthOfTextAtSize(nm, 10)) / 2, ctx.y, {
      size: 10,
      bold: true,
    });
  }
}

// ---------------------------------------------------------------------------
// Logo
// ---------------------------------------------------------------------------

/**
 * Tipo de imagen por MAGIC BYTES, no por content-type ni por extensión: el logo
 * vive en un bucket público y la URL puede mentir. pdf-lib solo embebe PNG y
 * JPEG; webp/svg/lo-que-sea devuelve null y el documento sale sin logo.
 */
export function detectLogoKind(bytes: Uint8Array): "png" | "jpg" | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return "png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  return null;
}

async function drawLogo(ctx: Ctx, logo: LogoImage | null | undefined, top: number): Promise<number> {
  if (!logo) return top;
  try {
    const img = logo.kind === "png"
      ? await ctx.doc.embedPng(logo.bytes)
      : await ctx.doc.embedJpg(logo.bytes);
    const maxH = 44;
    const maxW = 180;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    ctx.page.drawImage(img, { x: MARGIN, y: top - h, width: w, height: h });
    return top - h - 10;
  } catch (e) {
    // Un PNG corrupto no puede tumbar el correo: se sigue sin logo.
    console.warn("orderPdf: no pude embeber el logo:", e instanceof Error ? e.message : String(e));
    return top;
  }
}

// ---------------------------------------------------------------------------
// Cabecera compartida por los dos documentos
// ---------------------------------------------------------------------------

async function documentHeader(
  ctx: Ctx,
  s: OrderPdfSnapshot,
  logo: LogoImage | null | undefined,
  title: string,
  meta: string,
): Promise<void> {
  const top = ctx.y;

  // Bloque derecho (alto fijo, en coordenadas absolutas desde `top`).
  const rightEdge = MARGIN + CONTENT_W;
  const right = (text: string, y: number, opts: TextOpts) => {
    const font = opts.bold ? ctx.bold : ctx.font;
    const t = fitOneLine(ctx, text, font, opts.size ?? 10, 220);
    drawAt(ctx, t, rightEdge - font.widthOfTextAtSize(t, opts.size ?? 10), y, opts);
  };
  right(title, top - 11, { size: 11.5, bold: true });
  right(formatOrderNumber(s.order.order_number), top - 27, { size: 13, bold: true });
  right(meta, top - 40, { size: 8.5, color: MUTED });
  const rightEnd = top - 46;

  // Bloque izquierdo (logo + nombre + dirección), acotado para no chocar.
  ctx.y = await drawLogo(ctx, logo, top);
  para(ctx, s.shop.name ?? "Taller", { size: 15, bold: true, width: HEADER_LEFT_W });
  if (s.shop.address) {
    para(ctx, s.shop.address, { size: 8.5, color: MUTED, width: HEADER_LEFT_W });
  }
  if (s.shop.contact_phone) {
    para(ctx, `Tel. ${s.shop.contact_phone}`, { size: 8.5, color: MUTED, width: HEADER_LEFT_W });
  }

  ctx.y = Math.min(ctx.y, rightEnd);
  hr(ctx, 12, 16);
}

async function newDoc(): Promise<Ctx> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const ctx: Ctx = {
    doc,
    page: doc.addPage([PAGE_W, PAGE_H]),
    y: PAGE_H - MARGIN,
    font,
    bold,
    // El set de la fuente regular alcanza: las dos Helvetica comparten WinAnsi.
    charset: new Set(font.getCharacterSet()),
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Documento 1 — Orden de trabajo (espejo de OrderPrintView)
// ---------------------------------------------------------------------------

export async function renderOrderPdf(
  s: OrderPdfSnapshot,
  logo?: LogoImage | null,
): Promise<Uint8Array> {
  const ctx = await newDoc();
  ctx.doc.setTitle(`Orden ${formatOrderNumber(s.order.order_number)}`);
  ctx.doc.setProducer("AntawaTec");

  const estado = STATUS_LABELS[s.order.status] ?? s.order.status;
  await documentHeader(
    ctx,
    s,
    logo,
    "Orden de trabajo",
    `${fmtDate(s.order.created_at)} · ${estado}`,
  );

  twoUp(
    ctx,
    { label: "Cliente", value: s.customer?.name ?? "—" },
    { label: "Vehículo", value: vehicleLabel(s.vehicle) },
  );
  ctx.y -= 6;

  factsGrid(ctx, [
    { label: "Km ingreso", value: num(s.order.mileage_in) },
    { label: "Combustible", value: s.order.fuel_level ?? "—" },
    { label: "Técnico", value: s.technician?.full_name ?? "—" },
    {
      label: "Estimado",
      value: s.order.estimated_total != null ? money(s.order.estimated_total) : "—",
    },
  ]);
  hr(ctx, 6, 14);

  // Inventario de ingreso (checklist de recepción).
  const checked = (s.order.checklist?.items ?? []).filter((it) => it?.checked);
  const checklistNotes = s.order.checklist?.notes ?? "";
  if (checked.length > 0 || checklistNotes.trim()) {
    sectionTitle(ctx, "Inventario de ingreso");
    if (checked.length > 0) {
      para(ctx, checked.map((it) => it.label ?? "").filter(Boolean).join(" · "), { size: 10 });
    }
    if (checklistNotes.trim()) para(ctx, checklistNotes, { size: 9, color: MUTED });
    ctx.y -= 10;
  }

  if (s.catalog_summary.trim()) {
    sectionTitle(ctx, "Trabajos");
    para(ctx, s.catalog_summary, { size: 10 });
    ctx.y -= 10;
  }

  if (s.linked_quote) {
    sectionTitle(ctx, "Cotización");
    const estadoQ = s.linked_quote.status
      ? QUOTE_STATUS_LABELS[s.linked_quote.status] ?? s.linked_quote.status
      : "—";
    para(
      ctx,
      `${formatQuoteNumber(s.linked_quote.quote_number)} · ${estadoQ} · ${money(s.linked_quote.total)}`,
      { size: 10 },
    );
    ctx.y -= 10;
  }

  if (s.parts.length > 0) {
    sectionTitle(ctx, "Repuestos utilizados");
    partsTable(ctx, s.parts);
    ctx.y -= 10;
  }

  if (s.delivery) {
    sectionTitle(ctx, "Entrega");
    const km = s.delivery.final_mileage != null ? ` · ${num(s.delivery.final_mileage)} km` : "";
    para(ctx, `${fmtDateTime(s.delivery.delivered_at)}${km}`, { size: 9, color: MUTED });
    if (s.delivery.services_summary) para(ctx, s.delivery.services_summary, { size: 10 });
    if (s.delivery.future_maintenance) {
      para(ctx, `Mantenimiento sugerido: ${s.delivery.future_maintenance}`, {
        size: 9,
        color: MUTED,
      });
    }
    ctx.y -= 10;
  }

  // Descargo + firma: SOLO en este documento (se firma al recibir el vehículo).
  needRoom(ctx, 90);
  hr(ctx, 12, 12);
  para(ctx, "DESCARGO DE RESPONSABILIDAD", { size: 8, color: MUTED, gapAfter: 3 });
  para(ctx, LIABILITY_DISCLAIMER, { size: 8.5, color: MUTED, lineHeight: 11.5 });
  signatureBlock(ctx, "Firma del cliente", s.customer?.name ?? "");

  return await ctx.doc.save();
}

// ---------------------------------------------------------------------------
// Documento 2 — Recibo de entrega (espejo de DeliveryReceiptView)
// ---------------------------------------------------------------------------

export async function renderDeliveryReceiptPdf(
  s: OrderPdfSnapshot,
  logo?: LogoImage | null,
): Promise<Uint8Array> {
  const ctx = await newDoc();
  ctx.doc.setTitle(`Recibo de entrega ${formatOrderNumber(s.order.order_number)}`);
  ctx.doc.setProducer("AntawaTec");

  // `delivery` puede venir null (cierre rápido sin fila de entrega): el recibo
  // sale igual, con los campos de entrega en "—". No es un caso de error.
  await documentHeader(ctx, s, logo, "Recibo de entrega", fmtDateTime(s.delivery?.delivered_at));

  twoUp(
    ctx,
    { label: "Cliente", value: s.customer?.name ?? "—" },
    { label: "Vehículo", value: vehicleLabel(s.vehicle) },
  );
  ctx.y -= 6;

  factsGrid(ctx, [
    { label: "Km ingreso", value: num(s.order.mileage_in) },
    { label: "Km entrega", value: num(s.delivery?.final_mileage ?? null) },
    { label: "Técnico", value: s.technician?.full_name ?? "—" },
    {
      label: "Total",
      value: s.order.estimated_total != null ? money(s.order.estimated_total) : "—",
    },
  ]);
  hr(ctx, 6, 14);

  if (s.delivery?.services_summary) {
    sectionTitle(ctx, "Trabajos realizados");
    para(ctx, s.delivery.services_summary, { size: 10 });
    ctx.y -= 10;
  } else if (s.catalog_summary.trim()) {
    // Cierre rápido: sin resumen escrito, el recibo muestra lo que se marcó en
    // el catálogo (mismo criterio que el prefill del FE).
    sectionTitle(ctx, "Trabajos realizados");
    para(ctx, s.catalog_summary, { size: 10 });
    ctx.y -= 10;
  }

  if (s.parts.length > 0) {
    sectionTitle(ctx, "Repuestos utilizados");
    partsTable(ctx, s.parts);
    ctx.y -= 10;
  }

  if (s.delivery?.future_maintenance) {
    sectionTitle(ctx, "Mantenimiento sugerido");
    para(ctx, s.delivery.future_maintenance, { size: 10 });
    ctx.y -= 10;
  }

  // Sin descargo (se firmó en la recepción); solo conformidad de la entrega.
  signatureBlock(ctx, "Firma de conformidad del cliente", s.customer?.name ?? "");

  return await ctx.doc.save();
}

// ---------------------------------------------------------------------------
// Nombre de archivo del adjunto
// ---------------------------------------------------------------------------

/** "OT-0042-orden.pdf" / "OT-0042-recibo.pdf". */
export function pdfFileName(kind: "orden" | "recibo", orderNumber: number | null | undefined): string {
  return `${formatOrderNumber(orderNumber)}-${kind}.pdf`;
}

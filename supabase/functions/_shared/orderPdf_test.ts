// =============================================================================
// _shared/orderPdf_test.ts
// Tests del generador de PDFs. Sin red ni base: todo lo de acá es puro.
//
// Qué cubren, y por qué esas cosas: son los lugares donde un error costaría un
// correo roto (o 1.300) sin dejar rastro útil:
//   1. que salga un PDF válido (magic `%PDF-`) y que pdf-lib lo pueda releer,
//   2. la PAGINACIÓN — un resumen de catálogo largo no puede caerse del borde,
//   3. el SANEADO WinAnsi — un emoji en una nota lanzaría excepción en drawText
//      y mataría el envío entero,
//   4. el logo: sin logo, con PNG válido, y formato no embebible (webp),
//   5. el recibo SIN fila de entrega (cierre rápido) no lanza,
//   6. el nombre del archivo adjunto.
// =============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { PDFDocument, StandardFonts } from "npm:pdf-lib@1.17.1";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import {
  detectLogoKind,
  formatOrderNumber,
  pdfFileName,
  renderDeliveryReceiptPdf,
  renderOrderPdf,
  sanitizeForCharset,
  type OrderPdfSnapshot,
} from "./orderPdf.ts";

// PNG 1×1 transparente (el mínimo válido que pdf-lib sabe embeber).
const PNG_1X1 = decodeBase64(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
);

function snapshot(over: Partial<OrderPdfSnapshot> = {}): OrderPdfSnapshot {
  return {
    shop: { name: "Taller Pablo", address: "Av. Siempre Viva 742", contact_phone: "+59322345678" },
    order: {
      id: "wo-1",
      order_number: 42,
      status: "reception",
      created_at: "2026-09-22T14:30:00Z",
      mileage_in: 128500,
      fuel_level: "1/2",
      estimated_total: 1234.56,
      checklist: { items: [{ label: "Gata", checked: true }, { label: "Triángulos", checked: false }], notes: "sin llave de ruedas" },
    },
    customer: { name: "María Ñandú" },
    vehicle: { plate: "PBC-5251", make: "Chevrolet", model: "Sail", year: 2018 },
    technician: { full_name: "Andrés Pérez" },
    catalog_summary: "Mantenimiento\n- Aceite y filtro de motor\n  Nota: cliente trae repuestos",
    linked_quote: { quote_number: 7, status: "approved", total: 1234.56 },
    parts: [{ name: "Filtro de aceite", uom: "u", quantity: -2 }],
    delivery: null,
    ...over,
  };
}

const head = (bytes: Uint8Array) => new TextDecoder().decode(bytes.slice(0, 5));

// --- 1 / 2. PDF válido y paginación -----------------------------------------

Deno.test("renderOrderPdf: devuelve un PDF válido de una página", async () => {
  const bytes = await renderOrderPdf(snapshot());
  assertEquals(head(bytes), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assertEquals(doc.getPageCount(), 1);
});

Deno.test("renderOrderPdf: un resumen de catálogo de 200 líneas pagina", async () => {
  const catalog_summary = Array.from({ length: 200 }, (_, i) => `- Trabajo número ${i + 1}`).join("\n");
  const bytes = await renderOrderPdf(snapshot({ catalog_summary }));
  const doc = await PDFDocument.load(bytes);
  assert(doc.getPageCount() >= 2, `esperaba >= 2 páginas, salieron ${doc.getPageCount()}`);
});

Deno.test("renderOrderPdf: una descripción de repuesto larguísima no rompe la tabla", async () => {
  const bytes = await renderOrderPdf(snapshot({
    parts: [{ name: "Repuesto".repeat(120), uom: "u", quantity: -1 }],
  }));
  assertEquals(head(bytes), "%PDF-");
});

// --- 3. Saneado WinAnsi ------------------------------------------------------

Deno.test("sanitizeForCharset: conserva tildes y ñ, reemplaza lo no codificable", async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const charset = new Set(font.getCharacterSet());

  assertEquals(sanitizeForCharset(charset, "Mañana café"), "Mañana café");
  // "·" y "—" SÍ están en WinAnsi (los usa el formato del resumen).
  assertEquals(sanitizeForCharset(charset, "a · b — c"), "a · b — c");
  // "→", "✓" y los emoji no.
  assertEquals(sanitizeForCharset(charset, "a → b ✓"), "a ? b ?");
  assertEquals(sanitizeForCharset(charset, "listo 🚗"), "listo ?");
  // Invisibles y tabs: se descartan / colapsan, no se vuelven "?".
  assertEquals(sanitizeForCharset(charset, "a​b\tc\r\nd"), "ab c\nd");
});

Deno.test("renderOrderPdf: un emoji en una nota no lanza (iría a drawText sin sanear)", async () => {
  const bytes = await renderOrderPdf(snapshot({
    catalog_summary: "Mantenimiento\n- Aceite ✓ 🚗\n  Nota: revisar → frenos",
    customer: { name: "Cliente 🚗" },
  }));
  assertEquals(head(bytes), "%PDF-");
});

// --- 4. Logo -----------------------------------------------------------------

Deno.test("detectLogoKind: PNG, JPEG y cualquier otra cosa (webp)", () => {
  assertEquals(detectLogoKind(PNG_1X1), "png");
  assertEquals(detectLogoKind(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00])), "jpg");
  // "RIFF....WEBP"
  assertEquals(detectLogoKind(new TextEncoder().encode("RIFF____WEBPVP8 ")), null);
  assertEquals(detectLogoKind(new Uint8Array([])), null);
});

Deno.test("renderOrderPdf: con logo null y con PNG 1×1 produce PDF válido", async () => {
  assertEquals(head(await renderOrderPdf(snapshot(), null)), "%PDF-");
  assertEquals(head(await renderOrderPdf(snapshot(), { bytes: PNG_1X1, kind: "png" })), "%PDF-");
});

Deno.test("renderOrderPdf: un 'PNG' corrupto degrada a documento sin logo", async () => {
  const fake = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const bytes = await renderOrderPdf(snapshot(), { bytes: fake, kind: "png" });
  assertEquals(head(bytes), "%PDF-");
});

// --- 5. Recibo de entrega ----------------------------------------------------

Deno.test("renderDeliveryReceiptPdf: con entrega registrada", async () => {
  const bytes = await renderDeliveryReceiptPdf(snapshot({
    delivery: {
      delivered_at: "2026-09-22T21:05:00Z",
      final_mileage: 129000,
      services_summary: "- Cambio de aceite\n- Revisión de frenos",
      future_maintenance: "Próximo cambio a los 135.000 km",
    },
  }));
  assertEquals(head(bytes), "%PDF-");
  const doc = await PDFDocument.load(bytes);
  assertEquals(doc.getPageCount(), 1);
});

Deno.test("renderDeliveryReceiptPdf: SIN fila de entrega (cierre rápido) no lanza", async () => {
  const bytes = await renderDeliveryReceiptPdf(snapshot({ delivery: null }));
  assertEquals(head(bytes), "%PDF-");
});

Deno.test("renderDeliveryReceiptPdf: snapshot vacío de punta a punta no lanza", async () => {
  const bytes = await renderDeliveryReceiptPdf({
    shop: { name: null, address: null, contact_phone: null },
    order: {
      id: "wo-x",
      order_number: 0,
      status: "historical",
      created_at: null,
      mileage_in: null,
      fuel_level: null,
      estimated_total: null,
      checklist: null,
    },
    customer: null,
    vehicle: null,
    technician: null,
    catalog_summary: "",
    linked_quote: null,
    parts: [],
    delivery: null,
  });
  assertEquals(head(bytes), "%PDF-");
});

// --- 6. Nombres --------------------------------------------------------------

Deno.test("pdfFileName / formatOrderNumber: folio de 4 dígitos", () => {
  assertEquals(formatOrderNumber(42), "OT-0042");
  assertEquals(formatOrderNumber(null), "OT-0000");
  assertEquals(pdfFileName("orden", 42), "OT-0042-orden.pdf");
  assertEquals(pdfFileName("recibo", 7), "OT-0007-recibo.pdf");
  assertStringIncludes(pdfFileName("recibo", 12345), "OT-12345");
});

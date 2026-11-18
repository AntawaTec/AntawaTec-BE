// =============================================================================
// _shared/billing/sri_test.ts
// Tests de las reglas PURAS del SRI (sri.ts). Sin red ni base:
//   deno test --allow-env supabase/functions/
//
// Los números de identificación son FICTICIOS: patrones obvios (1711111110,
// 1799999990001, …) cuyo dígito verificador se calculó con el mismo algoritmo,
// no datos de personas o empresas reales.
// =============================================================================

import { assert, assertEquals, assertFalse, assertThrows } from "jsr:@std/assert@1";
import {
  buildInvoicePayload,
  computeInvoiceTotals,
  computeLine,
  CONSUMIDOR_FINAL_ID,
  diffStoredTotals,
  ecToday,
  formatInvoiceNumber,
  round2,
  toSriDate,
  validateBuyerId,
  validateCedula,
  validateDraft,
  validateRuc,
} from "./sri.ts";

// --- Cédula -------------------------------------------------------------------

Deno.test("validateCedula: válidas (dígito verificador módulo 10)", () => {
  for (const c of ["1711111110", "0912345675", "0100000009", "2222222222"]) {
    assert(validateCedula(c).ok, c);
  }
});

Deno.test("validateCedula: inválidas", () => {
  const cases: [string, string][] = [
    ["1711111111", "verificador"],
    ["171111111", "9 dígitos"],
    ["17111111100", "11 dígitos"],
    ["17111111a0", "letra"],
    ["2511111110", "provincia 25"],
    ["0011111110", "provincia 00"],
    ["1761111110", "tercer dígito 6"],
    ["", "vacía"],
  ];
  for (const [c, why] of cases) assertFalse(validateCedula(c).ok, `${c} (${why})`);
});

// --- RUC ----------------------------------------------------------------------

Deno.test("validateRuc: persona natural (cédula + establecimiento)", () => {
  const r = validateRuc("1712345675001");
  assert(r.ok);
  assertEquals(r.kind, "natural");
  assertFalse(validateRuc("1712345675000").ok, "establecimiento 000");
  assertFalse(validateRuc("1712345674001").ok, "cédula base inválida");
});

Deno.test("validateRuc: sociedad privada (3er dígito 9, sin dígito de control)", () => {
  // 1799999991001 NO cumple el módulo 11 clásico: debe aceptarse igual (los RUC
  // reales de sociedades ya no lo cumplen).
  for (const r of ["1799999990001", "0999999999001", "1799999991001"]) {
    const v = validateRuc(r);
    assert(v.ok, r);
    assertEquals(v.kind, "privada");
  }
  assertFalse(validateRuc("1799999990000").ok, "establecimiento 000");
});

Deno.test("validateRuc: sector público (3er dígito 6, sin dígito de control)", () => {
  for (const r of ["1760000070001", "0960000060001", "1761234510001", "1760000080001"]) {
    const v = validateRuc(r);
    assert(v.ok, r);
    assertEquals(v.kind, "publica");
  }
  assertFalse(validateRuc("1760000070000").ok, "establecimiento 0000");
});

Deno.test("validateRuc: formato y tercer dígito", () => {
  assertFalse(validateRuc("179999999001").ok, "12 dígitos");
  assertFalse(validateRuc("1779999990001").ok, "tercer dígito 7");
  assertFalse(validateRuc("1789999990001").ok, "tercer dígito 8");
  assertFalse(validateRuc("9999999999999").ok, "consumidor final no es un RUC");
});

Deno.test("validateBuyerId: por tipo", () => {
  assert(validateBuyerId("cedula", "1711111110").ok);
  assert(validateBuyerId("ruc", "1799999990001").ok);
  assert(validateBuyerId("consumidor_final", CONSUMIDOR_FINAL_ID).ok);
  assertFalse(validateBuyerId("consumidor_final", "1711111110").ok);
  assert(validateBuyerId("pasaporte", "AB123456").ok);
  assert(validateBuyerId("exterior", "X-99887766").ok);
  assertFalse(validateBuyerId("pasaporte", "A").ok);
  assertFalse(validateBuyerId("exterior", "con espacios 123").ok);
});

// --- Redondeo y totales ---------------------------------------------------------

Deno.test("round2: half-up exacto (sin el error de float de 1.005)", () => {
  assertEquals(round2(1.005), 1.01);
  assertEquals(round2(2.675), 2.68);
  assertEquals(round2(1.004999), 1.0);
  assertEquals(round2(0.125), 0.13);
  assertEquals(round2("10.555"), 10.56);
});

Deno.test("computeLine: cantidad × precio con decimales incómodos", () => {
  // 3 × 0.335 = 1.005 → 1.01 (en float daría 1.0049999… → 1.00)
  assertEquals(computeLine({ quantity: 3, unit_price: 0.335, tax_code: "4" }), { subtotal: 1.01, tax: 0.15, discount: 0 });
  // 1.5 × 33.333333 = 49.9999995 → 50.00
  assertEquals(computeLine({ quantity: 1.5, unit_price: 33.333333, tax_code: "4" }).subtotal, 50);
  // descuento: 2 × 10 − 1.50 = 18.50; IVA 15 % = 2.775 → 2.78
  assertEquals(computeLine({ quantity: 2, unit_price: 10, discount: 1.5, tax_code: "4" }), {
    subtotal: 18.5,
    tax: 2.78,
    discount: 1.5,
  });
  // IVA 5 %: 19.99 × 0.05 = 0.9995 → 1.00
  assertEquals(computeLine({ quantity: 1, unit_price: 19.99, tax_code: "5" }).tax, 1);
  // 0 %, no objeto y exento no llevan IVA
  for (const code of ["0", "6", "7"] as const) {
    assertEquals(computeLine({ quantity: 1, unit_price: 12.34, tax_code: code }).tax, 0);
  }
});

Deno.test("computeLine: errores de entrada", () => {
  assertThrows(() => computeLine({ quantity: 0, unit_price: 1, tax_code: "4" }));
  assertThrows(() => computeLine({ quantity: 1, unit_price: -1, tax_code: "4" }));
  assertThrows(() => computeLine({ quantity: 1, unit_price: 5, discount: 6, tax_code: "4" }));
  assertThrows(() => computeLine({ quantity: 1, unit_price: 5, tax_code: "9" as never }));
  assertThrows(() => computeLine({ quantity: "1.1234567", unit_price: 5, tax_code: "4" }), Error, "decimales");
});

Deno.test("computeInvoiceTotals: varias tarifas, IVA redondeado sobre la base AGRUPADA", () => {
  const t = computeInvoiceTotals([
    { quantity: 1, unit_price: 0.1, tax_code: "4" },
    { quantity: 1, unit_price: 0.1, tax_code: "4" },
    { quantity: 1, unit_price: 0.1, tax_code: "4" },
    { quantity: 2, unit_price: 19.99, tax_code: "5" },
    { quantity: 1, unit_price: 40, discount: 5, tax_code: "0" },
    { quantity: 1, unit_price: 3.5, tax_code: "6" },
    { quantity: 1, unit_price: 2.25, tax_code: "7" },
  ]);
  // Cada línea de 0.10 al 15 % tiene IVA 0.015 → 0.02, pero la tarifa agrupada es
  // 0.30 × 15 % = 0.045 → 0.05 (no 0.06): totalConImpuestos manda.
  assertEquals(t.lines.slice(0, 3).map((l) => l.tax), [0.02, 0.02, 0.02]);
  assertEquals(t.by_rate, [
    { tax_code: "4", rate: 15, base: 0.3, tax: 0.05 },
    { tax_code: "5", rate: 5, base: 39.98, tax: 2 }, // 1.999 → 2.00
    { tax_code: "0", rate: 0, base: 35, tax: 0 },
    { tax_code: "6", rate: 0, base: 3.5, tax: 0 },
    { tax_code: "7", rate: 0, base: 2.25, tax: 0 },
  ]);
  assertEquals(t.subtotal, 81.03);
  assertEquals(t.discount_total, 5);
  assertEquals(t.tax_total, 2.05);
  assertEquals(t.total, 83.08);
});

Deno.test("computeInvoiceTotals: suma de muchos centavos sin deriva de float", () => {
  const lines = Array.from({ length: 100 }, () => ({ quantity: 1, unit_price: 0.1, tax_code: "4" as const }));
  const t = computeInvoiceTotals(lines);
  assertEquals(t.subtotal, 10); // en float 0.1 × 100 sumado da 9.99999…
  assertEquals(t.tax_total, 1.5);
  assertEquals(t.total, 11.5);
  assertThrows(() => computeInvoiceTotals([]));
});

Deno.test("diffStoredTotals: cuadra al centavo o reporta qué no", () => {
  const lines = [{ quantity: 2, unit_price: 10, discount: 1.5, tax_code: "4" as const }];
  const t = computeInvoiceTotals(lines);
  const stored = [{ ...lines[0], line_subtotal: "18.50", line_tax: "2.78" }];
  assertEquals(diffStoredTotals({ subtotal: 18.5, discount_total: 1.5, tax_total: 2.78, total: 21.28 }, stored, t), []);
  const bad = diffStoredTotals({ subtotal: 18.5, discount_total: 1.5, tax_total: 2.77, total: 21.27 }, stored, t);
  assertEquals(bad.length, 2);
});

// --- Comprador y tope de consumidor final ------------------------------------------

Deno.test("validateDraft: consumidor final hasta USD 50", () => {
  const ok = computeInvoiceTotals([{ quantity: 1, unit_price: 43.47, tax_code: "4" }]); // 49.99
  const over = computeInvoiceTotals([{ quantity: 1, unit_price: 43.48, tax_code: "4" }]); // 50.00 → OK (≤ 50)
  const way = computeInvoiceTotals([{ quantity: 1, unit_price: 43.49, tax_code: "4" }]); // 50.01
  const buyer = { buyer_id_type: "consumidor_final" as const, buyer_id_number: CONSUMIDOR_FINAL_ID, buyer_name: "x" };
  assertEquals(ok.total, 49.99);
  assertEquals(over.total, 50);
  assertEquals(way.total, 50.01);
  assertEquals(validateDraft(buyer, ok, "01"), []);
  assertEquals(validateDraft(buyer, over, "01"), []);
  assertEquals(validateDraft(buyer, way, "01").length, 1);
});

Deno.test("validateDraft: identificación, nombre, correo y forma de pago", () => {
  const t = computeInvoiceTotals([{ quantity: 1, unit_price: 100, tax_code: "4" }]);
  assertEquals(
    validateDraft({ buyer_id_type: "ruc", buyer_id_number: "1799999990001", buyer_name: "Empresa Ficticia S.A." }, t, "20"),
    [],
  );
  const errs = validateDraft(
    { buyer_id_type: "cedula", buyer_id_number: "1711111111", buyer_name: "  ", buyer_email: "no-es-correo" },
    t,
    "99",
  );
  assertEquals(errs.length, 4);
});

// --- Fechas, números y payload ---------------------------------------------------------

Deno.test("ecToday / toSriDate / formatInvoiceNumber", () => {
  // 2026-11-10 03:00 UTC = 2026-11-09 22:00 en Ecuador
  assertEquals(ecToday(Date.UTC(2026, 10, 10, 3, 0)), "2026-11-09");
  assertEquals(ecToday(Date.UTC(2026, 10, 10, 5, 0)), "2026-11-10");
  assertEquals(toSriDate("2026-03-06"), "06/03/2026");
  assertThrows(() => toSriDate("06/03/2026"));
  assertEquals(formatInvoiceNumber("001", "002", "42"), "001-002-000000042");
  assertEquals(formatInvoiceNumber("001", "002", null), null);
});

Deno.test("buildInvoicePayload: factura con RUC, dos tarifas y RIMPE", () => {
  const p = buildInvoicePayload(
    {
      id: "11111111-2222-4333-8444-555555555555",
      buyer_id_type: "ruc",
      buyer_id_number: "1799999990001",
      buyer_name: "Empresa   Ficticia\nS.A.",
      buyer_address: "Av. Siempre Viva 123",
      buyer_email: "compras@example.com",
      buyer_phone: "0999999999",
      payment_method: "20",
      issued_on: "2026-11-09",
    },
    [
      { code: "MO-01", description: "Mano de obra", quantity: 2, unit_price: 25, tax_code: "4" },
      { code: null, description: "Repuesto exento", quantity: 1, unit_price: 10, discount: 1, tax_code: "0" },
    ],
    { establecimiento: "001", punto_emision: "002", obligado_contabilidad: false, regimen: "rimpe_emprendedor" },
  );
  assertEquals(p.tipoDocumento, "01");
  assertEquals(p.fechaEmision, "09/11/2026");
  assertEquals([p.establecimiento, p.puntoEmision], ["001", "002"]);
  assertEquals(p.tipoIdentificacionComprador, "04");
  assertEquals(p.razonSocialComprador, "Empresa Ficticia S.A.");
  assertEquals(p.direccionComprador, "Av. Siempre Viva 123");
  assertEquals(p.totalSinImpuestos, 59);
  assertEquals(p.totalDescuento, 1);
  assertEquals(p.totalConImpuestos, [
    { codigo: "2", codigoPorcentaje: "4", baseImponible: 50, tarifa: 15, valor: 7.5 },
    { codigo: "2", codigoPorcentaje: "0", baseImponible: 9, tarifa: 0, valor: 0 },
  ]);
  assertEquals(p.importeTotal, 66.5);
  assertEquals(p.pagos, [{ formaPago: "20", total: 66.5 }]);
  assertEquals(p.detalles[1].codigoPrincipal, "002"); // sin código → posición
  assertEquals(p.detalles[1].precioTotalSinImpuesto, 9);
  assertEquals(p.detalles[0].impuestos, [{ codigo: "2", codigoPorcentaje: "4", tarifa: 15, baseImponible: 50, valor: 7.5 }]);
  assertEquals(p.obligadoContabilidad, "NO");
  assertEquals(p.contribuyenteRimpe, "CONTRIBUYENTE RÉGIMEN RIMPE");
  assertEquals(p.idempotencyKey, "11111111-2222-4333-8444-555555555555");
  assertEquals(p.infoAdicional, [{ nombre: "Email", valor: "compras@example.com" }, { nombre: "Telefono", valor: "0999999999" }]);
  // Lo asigna el proveedor / no se manda: secuencial, claveAcceso, "RUC Proveedor".
  const keys = Object.keys(p);
  assertFalse(keys.includes("secuencial"));
  assertFalse(keys.includes("claveAcceso"));
  assertFalse(JSON.stringify(p).includes("RUC Proveedor"));
});

Deno.test("buildInvoicePayload: consumidor final fuerza identificación y nombre del SRI", () => {
  const p = buildInvoicePayload(
    {
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      buyer_id_type: "consumidor_final",
      buyer_id_number: CONSUMIDOR_FINAL_ID,
      buyer_name: "Cualquier nombre",
      buyer_address: "no va",
      payment_method: "01",
      issued_on: "2026-11-09",
    },
    [{ description: "Lavado", quantity: 1, unit_price: 10, tax_code: "4" }],
    { establecimiento: "001", punto_emision: "001", obligado_contabilidad: true, regimen: "general" },
  );
  assertEquals(p.tipoIdentificacionComprador, "07");
  assertEquals(p.identificacionComprador, "9999999999999");
  assertEquals(p.razonSocialComprador, "CONSUMIDOR FINAL");
  assertEquals(p.direccionComprador, undefined);
  assertEquals(p.obligadoContabilidad, "SI");
  assertEquals(p.contribuyenteRimpe, undefined);
  assertEquals(p.infoAdicional, undefined);
  assertEquals(p.importeTotal, 11.5);
});

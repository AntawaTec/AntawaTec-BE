// =============================================================================
// _shared/billing/sri.ts
// Reglas PURAS de la factura electrónica del SRI (ficha técnica 2.34):
// tablas, validación de cédula/RUC, cálculo de totales y armado del payload que
// se manda al proveedor.
//
// ⚠️ ESPEJO EN EL FRONTEND. El FE porta este archivo a `src/lib/sri.ts` para
// validar y calcular el borrador ANTES de guardarlo; `invoice-emit` recalcula con
// este mismo código y RECHAZA la emisión si los totales guardados no coinciden.
// Por eso este módulo es TypeScript sin dependencias: nada de Deno.*, nada de
// imports. Cambiar una regla acá = cambiarla en los dos repos en el mismo lote.
//
// Dinero: toda la aritmética va en enteros (BigInt), no en float. Cantidades y
// precios unitarios admiten 6 decimales (lo que acepta el XML del SRI); todo lo
// demás se redondea a 2 con redondeo comercial (half-up, los montos nunca son
// negativos). Así 1.005 → 1.01 siempre, corra donde corra.
// =============================================================================

// ---------- Tablas -----------------------------------------------------------

/** Código de impuesto IVA (tabla 16). Único impuesto que maneja la v1. */
export const IVA_CODE = "2";

/** codigoPorcentaje del IVA (tabla 17) → tarifa en %. */
export const IVA_RATES = {
  "0": { rate: 0, label: "IVA 0 %" },
  "4": { rate: 15, label: "IVA 15 %" },
  "5": { rate: 5, label: "IVA 5 %" },
  "6": { rate: 0, label: "No objeto de IVA" },
  "7": { rate: 0, label: "Exento de IVA" },
} as const;
export type TaxCode = keyof typeof IVA_RATES;
export const DEFAULT_TAX_CODE: TaxCode = "4";

export function isTaxCode(v: unknown): v is TaxCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(IVA_RATES, v);
}

/** Tipo de identificación del comprador (enum de la DB) → código SRI (tabla 6). */
export const BUYER_ID_CODES = {
  ruc: "04",
  cedula: "05",
  pasaporte: "06",
  consumidor_final: "07",
  exterior: "08",
} as const;
export type BuyerIdType = keyof typeof BUYER_ID_CODES;

export function isBuyerIdType(v: unknown): v is BuyerIdType {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(BUYER_ID_CODES, v);
}

/** Formas de pago (tabla 24). Las cuatro de uso común en un taller van primero. */
export const PAYMENT_METHODS = {
  "01": "Sin utilización del sistema financiero (efectivo)",
  "16": "Tarjeta de débito",
  "19": "Tarjeta de crédito",
  "20": "Otros con utilización del sistema financiero (transferencia)",
  "15": "Compensación de deudas",
  "17": "Dinero electrónico",
  "18": "Tarjeta prepago",
  "21": "Endoso de títulos",
} as const;
export type PaymentMethodCode = keyof typeof PAYMENT_METHODS;

export function isPaymentMethod(v: unknown): v is PaymentMethodCode {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(PAYMENT_METHODS, v);
}

export const CONSUMIDOR_FINAL_ID = "9999999999999";
export const CONSUMIDOR_FINAL_NAME = "CONSUMIDOR FINAL";
/** Una factura a consumidor final no puede superar este importe total (USD). */
export const CONSUMIDOR_FINAL_MAX_TOTAL = 50;

export type Regimen = "general" | "rimpe_emprendedor" | "rimpe_negocio_popular";
/** Leyenda `contribuyenteRimpe` del XML. El régimen general no lleva leyenda. */
export const RIMPE_LEGENDS: Record<Regimen, string | null> = {
  general: null,
  rimpe_emprendedor: "CONTRIBUYENTE RÉGIMEN RIMPE",
  rimpe_negocio_popular: "CONTRIBUYENTE NEGOCIO POPULAR - RÉGIMEN RIMPE",
};

// ---------- Identificación: cédula y RUC --------------------------------------

export type IdCheck = { ok: true } | { ok: false; reason: string };

const isDigits = (s: string, n: number) => s.length === n && /^[0-9]+$/.test(s);

/** Provincias válidas en los dos primeros dígitos: 01–24 y 30 (ecuatorianos en el exterior). */
function validProvince(two: string): boolean {
  const p = Number(two);
  return (p >= 1 && p <= 24) || p === 30;
}

/**
 * Cédula ecuatoriana: 10 dígitos, provincia válida, tercer dígito < 6 y dígito
 * verificador por módulo 10 (coeficientes 2,1,2,1,…; los productos > 9 restan 9).
 */
export function validateCedula(raw: string): IdCheck {
  const id = (raw ?? "").trim();
  if (!isDigits(id, 10)) return { ok: false, reason: "La cédula debe tener 10 dígitos." };
  if (!validProvince(id.slice(0, 2))) {
    return { ok: false, reason: "Los dos primeros dígitos de la cédula no son una provincia válida." };
  }
  if (Number(id[2]) >= 6) return { ok: false, reason: "El tercer dígito de la cédula no es válido." };
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(id[i]) * (i % 2 === 0 ? 2 : 1);
    if (v > 9) v -= 9;
    sum += v;
  }
  const check = (10 - (sum % 10)) % 10;
  if (check !== Number(id[9])) {
    return { ok: false, reason: "El dígito verificador de la cédula no es correcto." };
  }
  return { ok: true };
}

/** Módulo 11 de RUC de sociedades: devuelve el dígito esperado o null si da 10 (inválido). */
function mod11(digits: string, coefficients: number[]): number | null {
  let sum = 0;
  for (let i = 0; i < coefficients.length; i++) sum += Number(digits[i]) * coefficients[i];
  const r = sum % 11;
  const check = r === 0 ? 0 : 11 - r;
  return check === 10 ? null : check;
}

export type RucKind = "natural" | "privada" | "publica";

/**
 * Tipo de RUC según el tercer dígito: 0–5 persona natural, 6 sector público,
 * 9 sociedad privada / extranjera. Null si el tercer dígito no corresponde.
 */
export function rucKind(raw: string): RucKind | null {
  const d = Number((raw ?? "").trim()[2]);
  if (Number.isNaN(d)) return null;
  if (d < 6) return "natural";
  if (d === 6) return "publica";
  if (d === 9) return "privada";
  return null;
}

/**
 * RUC ecuatoriano (13 dígitos):
 *   - persona natural: los 10 primeros son una cédula válida; establecimiento ≠ 000.
 *   - sociedad privada (3er dígito 9): módulo 11 con 4,3,2,7,6,5,4,3,2 sobre los 9
 *     primeros, verificador en la posición 10; establecimiento (3 últimos) ≠ 000.
 *   - sector público (3er dígito 6): módulo 11 con 3,2,7,6,5,4,3,2 sobre los 8
 *     primeros, verificador en la posición 9; establecimiento (4 últimos) ≠ 0000.
 *
 * Conocido: hay RUC de sociedades emitidos por el SRI cuyo verificador NO cumple
 * el módulo 11. Este validador los rechaza (el comprador puede facturarse con su
 * cédula o el SRI aclarar el caso); si en el piloto aparece uno real, la salida es
 * relajar SOLO el chequeo de verificador de 'privada', en los dos repos.
 */
export function validateRuc(raw: string): IdCheck & { kind?: RucKind } {
  const id = (raw ?? "").trim();
  if (!isDigits(id, 13)) return { ok: false, reason: "El RUC debe tener 13 dígitos." };
  if (!validProvince(id.slice(0, 2))) {
    return { ok: false, reason: "Los dos primeros dígitos del RUC no son una provincia válida." };
  }
  const kind = rucKind(id);
  if (kind === null) return { ok: false, reason: "El tercer dígito del RUC no es válido." };

  if (kind === "natural") {
    const ced = validateCedula(id.slice(0, 10));
    if (!ced.ok) return { ok: false, reason: "Los 10 primeros dígitos del RUC no son una cédula válida." };
    if (id.slice(10) === "000") return { ok: false, reason: "El RUC debe terminar en un establecimiento (001 o más)." };
    return { ok: true, kind };
  }

  if (kind === "privada") {
    const check = mod11(id, [4, 3, 2, 7, 6, 5, 4, 3, 2]);
    if (check === null || check !== Number(id[9])) {
      return { ok: false, reason: "El dígito verificador del RUC no es correcto." };
    }
    if (id.slice(10) === "000") return { ok: false, reason: "El RUC debe terminar en un establecimiento (001 o más)." };
    return { ok: true, kind };
  }

  // pública
  const check = mod11(id, [3, 2, 7, 6, 5, 4, 3, 2]);
  if (check === null || check !== Number(id[8])) {
    return { ok: false, reason: "El dígito verificador del RUC no es correcto." };
  }
  if (id.slice(9) === "0000") return { ok: false, reason: "El RUC debe terminar en un establecimiento (0001 o más)." };
  return { ok: true, kind };
}

/** Valida el número según el tipo de identificación del comprador. */
export function validateBuyerId(type: BuyerIdType, raw: string): IdCheck {
  const id = (raw ?? "").trim();
  switch (type) {
    case "cedula":
      return validateCedula(id);
    case "ruc": {
      const r = validateRuc(id);
      return r.ok ? { ok: true } : { ok: false, reason: r.reason };
    }
    case "consumidor_final":
      return id === CONSUMIDOR_FINAL_ID
        ? { ok: true }
        : { ok: false, reason: `La identificación de consumidor final es ${CONSUMIDOR_FINAL_ID}.` };
    case "pasaporte":
    case "exterior":
      if (id.length < 3 || id.length > 20 || !/^[A-Za-z0-9-]+$/.test(id)) {
        return { ok: false, reason: "La identificación debe tener de 3 a 20 letras o números." };
      }
      return { ok: true };
  }
}

// ---------- Dinero exacto -------------------------------------------------------

/**
 * Convierte un monto (number o string decimal) a entero escalado a `scale`
 * decimales. Lanza si trae más decimales de los permitidos o no es un número.
 * Con number se usa toFixed(scale), que redondea la representación binaria al
 * decimal más cercano: exacto para cualquier valor que venga de un numeric de
 * Postgres con esa escala.
 */
export function toScaled(value: number | string, scale: number): bigint {
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Monto inválido: ${value}`);
    s = value.toFixed(scale);
  } else {
    s = value.trim();
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Monto inválido: ${value}`);
  const frac = m[3] ?? "";
  if (frac.length > scale) {
    // Solo se tolera si los dígitos sobrantes son ceros ("10.500" con scale 2).
    if (!/^0*$/.test(frac.slice(scale))) throw new Error(`Monto con demasiados decimales: ${value}`);
  }
  const digits = m[2] + frac.slice(0, scale).padEnd(scale, "0");
  const n = BigInt(digits);
  return m[1] === "-" ? -n : n;
}

/** Divide redondeando half-up (para numeradores >= 0). */
function divRound(num: bigint, den: bigint): bigint {
  if (num < 0n) throw new Error("divRound: numerador negativo");
  return (num * 2n + den) / (den * 2n);
}

/** Centavos → número con 2 decimales (para JSON y para comparar con la DB). */
export function centsToNumber(c: bigint): number {
  return Number(c) / 100;
}

/** Redondeo a 2 decimales half-up, exacto (sin el error de 1.005 → 1.00). */
export function round2(value: number | string): number {
  const micro = toScaled(typeof value === "number" ? value.toFixed(8) : value, 8);
  if (micro < 0n) return -centsToNumber(divRound(-micro, 1_000_000n));
  return centsToNumber(divRound(micro, 1_000_000n));
}

// ---------- Totales -------------------------------------------------------------

export interface LineInput {
  quantity: number | string;   // hasta 6 decimales, > 0
  unit_price: number | string; // hasta 6 decimales, >= 0
  discount?: number | string;  // 2 decimales, >= 0
  tax_code: TaxCode;
}

export interface LineTotals {
  subtotal: number; // precioTotalSinImpuesto = cantidad × precio − descuento
  tax: number;      // IVA de la línea = subtotal × tarifa
  discount: number;
}

export interface RateTotal {
  tax_code: TaxCode;
  rate: number;
  base: number;     // baseImponible de la tarifa = Σ subtotales de sus líneas
  tax: number;      // valor = base × tarifa (redondeado UNA vez, sobre la base agrupada)
}

export interface InvoiceTotals {
  lines: LineTotals[];
  by_rate: RateTotal[];
  subtotal: number;        // totalSinImpuestos (neto de descuentos)
  discount_total: number;  // totalDescuento
  tax_total: number;       // Σ valor por tarifa
  total: number;           // importeTotal = subtotal + tax_total
}

interface LineCents { subtotal: bigint; tax: bigint; discount: bigint }

function lineCents(line: LineInput): LineCents {
  if (!isTaxCode(line.tax_code)) throw new Error(`Tarifa de IVA desconocida: ${line.tax_code}`);
  const q = toScaled(line.quantity, 6);
  const p = toScaled(line.unit_price, 6);
  const d = toScaled(line.discount ?? 0, 2);
  if (q <= 0n) throw new Error("La cantidad debe ser mayor que 0.");
  if (p < 0n) throw new Error("El precio unitario no puede ser negativo.");
  if (d < 0n) throw new Error("El descuento no puede ser negativo.");
  // q·p está escalado a 12 decimales → a centavos (2) dividiendo por 10^10.
  const gross = divRound(q * p, 10_000_000_000n);
  if (d > gross) throw new Error("El descuento no puede superar el valor de la línea.");
  const subtotal = gross - d;
  const rate = BigInt(IVA_RATES[line.tax_code].rate);
  const tax = divRound(subtotal * rate, 100n);
  return { subtotal, tax, discount: d };
}

/** Totales de una línea (lo que el FE muestra por fila y guarda en invoice_items). */
export function computeLine(line: LineInput): LineTotals {
  const c = lineCents(line);
  return { subtotal: centsToNumber(c.subtotal), tax: centsToNumber(c.tax), discount: centsToNumber(c.discount) };
}

/**
 * Totales de la factura. Regla (la misma en FE y BE):
 *   - línea: subtotal = round2(cantidad × precio) − descuento; IVA = round2(subtotal × tarifa).
 *   - por tarifa: base = Σ subtotales; valor = round2(base × tarifa) — redondeado
 *     UNA vez sobre la base agrupada, no la suma de los IVA de línea (que puede
 *     diferir en un centavo). Es lo que va en totalConImpuestos.
 *   - tax_total = Σ valores por tarifa; total = subtotal + tax_total.
 * Lanza Error con mensaje en español si una línea es inválida.
 */
export function computeInvoiceTotals(lines: LineInput[]): InvoiceTotals {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error("La factura no tiene líneas.");
  const cents = lines.map(lineCents);
  const order: TaxCode[] = [];
  const bases = new Map<TaxCode, bigint>();
  lines.forEach((l, i) => {
    if (!bases.has(l.tax_code)) {
      bases.set(l.tax_code, 0n);
      order.push(l.tax_code);
    }
    bases.set(l.tax_code, bases.get(l.tax_code)! + cents[i].subtotal);
  });
  let subtotal = 0n;
  let discount = 0n;
  for (const c of cents) {
    subtotal += c.subtotal;
    discount += c.discount;
  }
  let taxTotal = 0n;
  const byRate: RateTotal[] = order.map((code) => {
    const base = bases.get(code)!;
    const rate = IVA_RATES[code].rate;
    const tax = divRound(base * BigInt(rate), 100n);
    taxTotal += tax;
    return { tax_code: code, rate, base: centsToNumber(base), tax: centsToNumber(tax) };
  });
  return {
    lines: cents.map((c) => ({
      subtotal: centsToNumber(c.subtotal),
      tax: centsToNumber(c.tax),
      discount: centsToNumber(c.discount),
    })),
    by_rate: byRate,
    subtotal: centsToNumber(subtotal),
    discount_total: centsToNumber(discount),
    tax_total: centsToNumber(taxTotal),
    total: centsToNumber(subtotal + taxTotal),
  };
}

export interface StoredTotals {
  subtotal: number | string;
  discount_total: number | string;
  tax_total: number | string;
  total: number | string;
}
export interface StoredLine extends LineInput {
  line_subtotal: number | string;
  line_tax: number | string;
}

/**
 * Compara lo guardado en la DB con lo recalculado. Devuelve la lista de
 * diferencias (vacía = cuadra). Comparación exacta al centavo.
 */
export function diffStoredTotals(stored: StoredTotals, lines: StoredLine[], computed: InvoiceTotals): string[] {
  const out: string[] = [];
  const same = (a: number | string, b: number) => toScaled(a, 2) === toScaled(b, 2);
  lines.forEach((l, i) => {
    const c = computed.lines[i];
    if (!same(l.line_subtotal, c.subtotal)) out.push(`línea ${i + 1}: subtotal ${l.line_subtotal} ≠ ${c.subtotal}`);
    if (!same(l.line_tax, c.tax)) out.push(`línea ${i + 1}: IVA ${l.line_tax} ≠ ${c.tax}`);
  });
  if (!same(stored.subtotal, computed.subtotal)) out.push(`subtotal ${stored.subtotal} ≠ ${computed.subtotal}`);
  if (!same(stored.discount_total, computed.discount_total)) {
    out.push(`descuento ${stored.discount_total} ≠ ${computed.discount_total}`);
  }
  if (!same(stored.tax_total, computed.tax_total)) out.push(`IVA ${stored.tax_total} ≠ ${computed.tax_total}`);
  if (!same(stored.total, computed.total)) out.push(`total ${stored.total} ≠ ${computed.total}`);
  return out;
}

// ---------- Fechas y números ------------------------------------------------------

const EC_OFFSET_MS = -5 * 3600_000; // Ecuador no tiene horario de verano
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Fecha de HOY en Ecuador, 'YYYY-MM-DD'. */
export function ecToday(nowMs: number): string {
  const d = new Date(nowMs + EC_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 'YYYY-MM-DD' → 'DD/MM/AAAA' (formato de fechaEmision). */
export function toSriDate(isoDate: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate ?? "");
  if (!m) throw new Error(`Fecha inválida: ${isoDate}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Número legible del comprobante: 001-001-000000042. Null si falta una parte. */
export function formatInvoiceNumber(
  establecimiento: string | null | undefined,
  puntoEmision: string | null | undefined,
  secuencial: string | null | undefined,
): string | null {
  if (!establecimiento || !puntoEmision || !secuencial) return null;
  return `${establecimiento}-${puntoEmision}-${secuencial.padStart(9, "0")}`;
}

// ---------- Validación del borrador -------------------------------------------------

export interface DraftBuyer {
  buyer_id_type: BuyerIdType;
  buyer_id_number: string;
  buyer_name: string;
  buyer_address?: string | null;
  buyer_email?: string | null;
}

/** Errores (en español, para el usuario) del comprador y del tope de consumidor final. */
export function validateDraft(buyer: DraftBuyer, totals: InvoiceTotals, paymentMethod: string): string[] {
  const errors: string[] = [];
  if (!isBuyerIdType(buyer.buyer_id_type)) {
    errors.push("El tipo de identificación del comprador no es válido.");
  } else {
    const id = validateBuyerId(buyer.buyer_id_type, buyer.buyer_id_number);
    if (!id.ok) errors.push(id.reason);
    if (buyer.buyer_id_type === "consumidor_final" && totals.total > CONSUMIDOR_FINAL_MAX_TOTAL) {
      errors.push(
        `Una factura a consumidor final no puede superar USD ${CONSUMIDOR_FINAL_MAX_TOTAL}. ` +
          "Pídele al cliente su cédula o RUC.",
      );
    }
  }
  const name = (buyer.buyer_name ?? "").trim();
  if (name.length === 0 || name.length > 300) errors.push("El nombre del comprador es obligatorio (máximo 300 caracteres).");
  if ((buyer.buyer_address ?? "").length > 300) errors.push("La dirección del comprador no puede superar 300 caracteres.");
  const email = (buyer.buyer_email ?? "").trim();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push("El correo del comprador no es válido.");
  if (!isPaymentMethod(paymentMethod)) errors.push("La forma de pago no es válida.");
  if (totals.total <= 0) errors.push("El total de la factura debe ser mayor que 0.");
  return errors;
}

// ---------- Payload del proveedor -----------------------------------------------------

/** Lo que el SRI necesita del emisor (sale de shop_billing_settings). */
export interface IssuerSettings {
  establecimiento: string;
  punto_emision: string;
  obligado_contabilidad: boolean;
  regimen: Regimen;
  contribuyente_especial?: string | null;
}

export interface PayloadItem extends LineInput {
  code?: string | null;
  description: string;
}

export interface PayloadInvoice extends DraftBuyer {
  id: string; // uuid → idempotencyKey
  buyer_phone?: string | null;
  payment_method: PaymentMethodCode;
  issued_on: string; // 'YYYY-MM-DD'
}

export interface InvoicePayload {
  tipoDocumento: "01";
  fechaEmision: string;
  establecimiento: string;
  puntoEmision: string;
  tipoIdentificacionComprador: string;
  razonSocialComprador: string;
  identificacionComprador: string;
  direccionComprador?: string;
  emailComprador?: string;
  totalSinImpuestos: number;
  totalDescuento: number;
  totalConImpuestos: { codigo: string; codigoPorcentaje: string; baseImponible: number; tarifa: number; valor: number }[];
  propina: number;
  importeTotal: number;
  moneda: "DOLAR";
  pagos: { formaPago: string; total: number }[];
  detalles: {
    codigoPrincipal: string;
    descripcion: string;
    cantidad: number;
    precioUnitario: number;
    descuento: number;
    precioTotalSinImpuesto: number;
    impuestos: { codigo: string; codigoPorcentaje: string; tarifa: number; baseImponible: number; valor: number }[];
  }[];
  infoAdicional?: { nombre: string; valor: string }[];
  obligadoContabilidad: "SI" | "NO";
  contribuyenteRimpe?: string;
  contribuyenteEspecial?: string;
  idempotencyKey: string;
}

/** Recorta y colapsa espacios; el SRI no acepta saltos de línea en los campos de texto. */
function clean(s: string | null | undefined, max: number): string {
  return (s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Arma el body de emisión. Usa los nombres del XML del SRI en camelCase, que es
 * lo que recibe AutorizadorEC en POST /documents(/emit). NO incluye `secuencial`
 * ni `claveAcceso` (los asigna el proveedor, modo platform) ni el campo "RUC
 * Proveedor" (lo agrega el proveedor solo, Res. NAC-DGERCGC26-00000027).
 */
export function buildInvoicePayload(
  invoice: PayloadInvoice,
  items: PayloadItem[],
  issuer: IssuerSettings,
): InvoicePayload {
  const totals = computeInvoiceTotals(items);
  const cf = invoice.buyer_id_type === "consumidor_final";

  const detalles = items.map((it, i) => {
    const line = totals.lines[i];
    const rate = IVA_RATES[it.tax_code].rate;
    return {
      codigoPrincipal: clean(it.code, 25) || String(i + 1).padStart(3, "0"),
      descripcion: clean(it.description, 300),
      cantidad: Number(toScaled(it.quantity, 6)) / 1e6,
      precioUnitario: Number(toScaled(it.unit_price, 6)) / 1e6,
      descuento: line.discount,
      precioTotalSinImpuesto: line.subtotal,
      impuestos: [{
        codigo: IVA_CODE,
        codigoPorcentaje: it.tax_code,
        tarifa: rate,
        baseImponible: line.subtotal,
        valor: line.tax,
      }],
    };
  });

  const info: { nombre: string; valor: string }[] = [];
  const email = clean(invoice.buyer_email, 300);
  const phone = clean(invoice.buyer_phone, 300);
  if (email) info.push({ nombre: "Email", valor: email });
  if (phone) info.push({ nombre: "Telefono", valor: phone });

  const payload: InvoicePayload = {
    tipoDocumento: "01",
    fechaEmision: toSriDate(invoice.issued_on),
    establecimiento: issuer.establecimiento,
    puntoEmision: issuer.punto_emision,
    tipoIdentificacionComprador: BUYER_ID_CODES[invoice.buyer_id_type],
    razonSocialComprador: cf ? CONSUMIDOR_FINAL_NAME : clean(invoice.buyer_name, 300),
    identificacionComprador: cf ? CONSUMIDOR_FINAL_ID : clean(invoice.buyer_id_number, 20),
    totalSinImpuestos: totals.subtotal,
    totalDescuento: totals.discount_total,
    totalConImpuestos: totals.by_rate.map((r) => ({
      codigo: IVA_CODE,
      codigoPorcentaje: r.tax_code,
      baseImponible: r.base,
      tarifa: r.rate,
      valor: r.tax,
    })),
    propina: 0,
    importeTotal: totals.total,
    moneda: "DOLAR",
    pagos: [{ formaPago: invoice.payment_method, total: totals.total }],
    detalles,
    obligadoContabilidad: issuer.obligado_contabilidad ? "SI" : "NO",
    idempotencyKey: invoice.id,
  };
  const address = clean(invoice.buyer_address, 300);
  if (address && !cf) payload.direccionComprador = address;
  if (email) payload.emailComprador = email;
  if (info.length > 0) payload.infoAdicional = info;
  const rimpe = RIMPE_LEGENDS[issuer.regimen] ?? null;
  if (rimpe) payload.contribuyenteRimpe = rimpe;
  const especial = clean(issuer.contribuyente_especial, 13);
  if (especial) payload.contribuyenteEspecial = especial;
  return payload;
}

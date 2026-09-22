// =============================================================================
// _shared/subscriptionPeriod_test.ts
// Tests de la aritmética del período de suscripción. Todo PURO: sin red, sin
// base, sin env (corre con `deno test --allow-env supabase/functions/`, que es
// el comando del CI; acá ni siquiera hace falta el permiso).
//
// Qué cubren y por qué: los dos únicos lugares donde un error se traduce en
// plata o en un taller cortado por error —
//   1. el clamp de fin de mes (31-ene no puede dar 3-mar),
//   2. de dónde arranca el mes pagado (vigente ⇒ apila; vencido ⇒ desde ahora).
// =============================================================================

import { assertEquals } from "jsr:@std/assert@1";
import {
  addCalendarMonth,
  computeRenewalPeriod,
  maxDate,
  parseTimestamp,
} from "./subscriptionPeriod.ts";

const iso = (d: Date) => d.toISOString();

// --- 1. Mes calendario con clamp de fin de mes -------------------------------

Deno.test("addCalendarMonth: 31-ene → 28-feb en año NO bisiesto", () => {
  assertEquals(
    iso(addCalendarMonth(new Date("2026-01-31T10:30:00.000Z"))),
    "2026-02-28T10:30:00.000Z",
  );
});

Deno.test("addCalendarMonth: 31-ene → 29-feb en año bisiesto", () => {
  assertEquals(
    iso(addCalendarMonth(new Date("2028-01-31T10:30:00.000Z"))),
    "2028-02-29T10:30:00.000Z",
  );
});

Deno.test("addCalendarMonth: 15-mar → 15-abr (día normal, hora intacta)", () => {
  assertEquals(
    iso(addCalendarMonth(new Date("2026-03-15T23:59:59.999Z"))),
    "2026-04-15T23:59:59.999Z",
  );
});

Deno.test("addCalendarMonth: 31-mar → 30-abr (clamp a mes de 30 días)", () => {
  assertEquals(
    iso(addCalendarMonth(new Date("2026-03-31T08:00:00.000Z"))),
    "2026-04-30T08:00:00.000Z",
  );
});

Deno.test("addCalendarMonth: 31-dic → 31-ene (cambio de año)", () => {
  assertEquals(
    iso(addCalendarMonth(new Date("2026-12-31T00:00:00.000Z"))),
    "2027-01-31T00:00:00.000Z",
  );
});

Deno.test("addCalendarMonth: 29-feb bisiesto → 29-mar (no recorta de más)", () => {
  assertEquals(
    iso(addCalendarMonth(new Date("2028-02-29T12:00:00.000Z"))),
    "2028-03-29T12:00:00.000Z",
  );
});

// --- 2. De dónde arranca el mes pagado ---------------------------------------

Deno.test("computeRenewalPeriod: suscripción VIGENTE apila sobre current_period_end", () => {
  const now = new Date("2026-03-10T15:00:00.000Z");
  const vigente = new Date("2026-03-20T15:00:00.000Z");

  const period = computeRenewalPeriod(vigente, now);

  assertEquals(iso(period.start), "2026-03-20T15:00:00.000Z");
  assertEquals(iso(period.end), "2026-04-20T15:00:00.000Z");
});

Deno.test("computeRenewalPeriod: suscripción VENCIDA arranca desde now (no retro-cubre)", () => {
  const now = new Date("2026-03-10T15:00:00.000Z");
  const vencida = new Date("2026-02-01T15:00:00.000Z");

  const period = computeRenewalPeriod(vencida, now);

  assertEquals(iso(period.start), "2026-03-10T15:00:00.000Z");
  assertEquals(iso(period.end), "2026-04-10T15:00:00.000Z");
});

Deno.test("computeRenewalPeriod: sin suscripción previa arranca desde now", () => {
  const now = new Date("2026-01-31T09:00:00.000Z");

  const period = computeRenewalPeriod(null, now);

  assertEquals(iso(period.start), "2026-01-31T09:00:00.000Z");
  assertEquals(iso(period.end), "2026-02-28T09:00:00.000Z");
});

Deno.test("computeRenewalPeriod: es CONVERGENTE — recalcular con el mismo now da lo mismo", () => {
  // La idempotencia real la da el period_end guardado en el proof, pero la
  // función no debe introducir deriva por sí sola.
  const now = new Date("2026-05-05T00:00:00.000Z");
  const a = computeRenewalPeriod(new Date("2026-05-31T00:00:00.000Z"), now);
  const b = computeRenewalPeriod(new Date("2026-05-31T00:00:00.000Z"), now);

  assertEquals(iso(a.end), iso(b.end));
  assertEquals(iso(a.end), "2026-06-30T00:00:00.000Z");
});

// --- 3. Utilidades -----------------------------------------------------------

Deno.test("parseTimestamp: null/vacío/inválido → null; ISO válido → Date", () => {
  assertEquals(parseTimestamp(null), null);
  assertEquals(parseTimestamp(undefined), null);
  assertEquals(parseTimestamp(""), null);
  assertEquals(parseTimestamp("no-es-una-fecha"), null);
  assertEquals(
    iso(parseTimestamp("2026-03-20T15:00:00+00:00")!),
    "2026-03-20T15:00:00.000Z",
  );
});

Deno.test("maxDate: el vencimiento nunca retrocede", () => {
  const menor = new Date("2026-03-01T00:00:00.000Z");
  const mayor = new Date("2026-04-01T00:00:00.000Z");

  assertEquals(iso(maxDate(menor, mayor)!), iso(mayor));
  assertEquals(iso(maxDate(mayor, menor)!), iso(mayor));
  assertEquals(iso(maxDate(null, mayor)!), iso(mayor));
  assertEquals(iso(maxDate(mayor, null)!), iso(mayor));
  assertEquals(maxDate(null, null), null);
});

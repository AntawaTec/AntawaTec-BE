// =============================================================================
// _shared/ecTime_test.ts
// El reloj del taller decide a qué hora sale el recordatorio del día: si el día
// de Ecuador se calcula mal, el aviso de las 07:00 sale a las 02:00 o un día
// antes. Puro, sin red ni base.
// =============================================================================

import { assertEquals } from "jsr:@std/assert@1";
import { ecDayStartMs, ecMinutesOfDay, fmtEcDateTime, fmtEcTime } from "./ecTime.ts";

Deno.test("ecDayStartMs: la medianoche de Ecuador son las 05:00 UTC del mismo día", () => {
  // 2026-10-06 00:30 UTC es todavía el 5 de octubre en Ecuador (19:30).
  assertEquals(new Date(ecDayStartMs(Date.parse("2026-10-06T00:30:00Z"))).toISOString(), "2026-10-05T05:00:00.000Z");
  // 2026-10-06 12:00 UTC = 07:00 en Ecuador del 6.
  assertEquals(new Date(ecDayStartMs(Date.parse("2026-10-06T12:00:00Z"))).toISOString(), "2026-10-06T05:00:00.000Z");
});

Deno.test("ecMinutesOfDay: las 07:00 de Ecuador son 420 minutos", () => {
  assertEquals(ecMinutesOfDay(Date.parse("2026-10-06T12:00:00Z")), 420);
  assertEquals(ecMinutesOfDay(Date.parse("2026-10-06T11:59:00Z")), 419);
  assertEquals(ecMinutesOfDay(Date.parse("2026-10-06T04:59:00Z")), 23 * 60 + 59);
});

Deno.test("fmt: fecha y hora en -05:00, null si no parsea", () => {
  assertEquals(fmtEcDateTime("2026-10-05T13:30:00+00:00"), "05/10/2026 a las 08:30");
  assertEquals(fmtEcTime("2026-10-06T01:00:00Z"), "20:00");
  assertEquals(fmtEcDateTime("nope"), null);
  assertEquals(fmtEcTime(null), null);
});

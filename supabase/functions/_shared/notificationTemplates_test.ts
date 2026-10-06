// =============================================================================
// _shared/notificationTemplates_test.ts
// La fecha de la cita que lee el cliente. `scheduled_at` es timestamptz (UTC) y
// el taller agenda en hora de Ecuador (-05:00 fijo): el mensaje tiene que decir
// la hora del taller, no la del servidor. Puro, sin red ni base.
// =============================================================================

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { renderTemplate } from "./notificationTemplates.ts";

const base = { customer_name: "Ana", plate: "ABC1234", shop_name: "Taller X" };

Deno.test("recordatorio: la hora sale en hora de Ecuador, no en UTC", () => {
  // 08:30 en Ecuador = 13:30 UTC (el caso real que reportó el taller).
  const r = renderTemplate("appointment_reminder_24h", { ...base, scheduled_at: "2026-10-05T13:30:00+00:00" })!;
  assertEquals(r.components[2], "05/10/2026 a las 08:30");
  assertStringIncludes(r.text, "mañana 05/10/2026 a las 08:30.");
});

Deno.test("confirmación: una cita de madrugada UTC cae en el día anterior de Ecuador", () => {
  // 20:00 del 5 en Ecuador = 01:00 UTC del 6.
  const r = renderTemplate("appointment_confirmed", { ...base, scheduled_at: "2026-10-06T01:00:00Z" })!;
  assertEquals(r.components[2], "05/10/2026 a las 20:00");
});

Deno.test("sin fecha (o ilegible) cae al texto genérico", () => {
  assertEquals(renderTemplate("appointment_confirmed", { ...base, scheduled_at: null })!.components[2], "la fecha agendada");
  assertEquals(renderTemplate("appointment_confirmed", { ...base, scheduled_at: "nope" })!.components[2], "la fecha agendada");
});

Deno.test("recordatorio del día: 'hoy' va en el cuerpo y la variable 3 es solo la hora de Ecuador", () => {
  const r = renderTemplate("appointment_reminder_today", { ...base, scheduled_at: "2026-10-06T13:00:00Z" })!;
  assertEquals(r.components, ["Ana", "ABC1234", "08:00", "Taller X"]);
  assertStringIncludes(r.text, "hoy tienes tu cita para tu vehículo ABC1234 a las 08:00.");
});

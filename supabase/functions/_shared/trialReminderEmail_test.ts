// =============================================================================
// _shared/trialReminderEmail_test.ts
// Tests del correo "tu prueba termina" (PURO, sin red). Lo que no puede romperse:
// la fecha sale en hora de Ecuador (un vencimiento de madrugada UTC es el día
// anterior para el dueño), el nombre del taller pasa por `esc`, y el cuerpo
// lleva el precio y el camino para renovar.
// =============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { ecDayMonth, ecDaysLeft, renderTrialReminder } from "./trialReminderEmail.ts";

Deno.test("ecDayMonth: fecha en hora de Ecuador (UTC-5)", () => {
  assertEquals(ecDayMonth(new Date("2026-11-29T15:00:00Z")), "29 de noviembre");
  // 02:00 UTC del 30 = 21:00 del 29 en Ecuador.
  assertEquals(ecDayMonth(new Date("2026-11-30T02:00:00Z")), "29 de noviembre");
  assertEquals(ecDayMonth(new Date("2027-01-01T05:00:00Z")), "1 de enero");
});

Deno.test("ecDaysLeft: días de calendario de Ecuador, nunca negativos", () => {
  const now = new Date("2026-11-22T13:00:00Z"); // 08:00 EC del 22
  assertEquals(ecDaysLeft(new Date("2026-11-29T20:00:00Z"), now), 7);
  assertEquals(ecDaysLeft(new Date("2026-11-23T04:00:00Z"), now), 0); // 23:00 EC del 22
  assertEquals(ecDaysLeft(new Date("2026-11-23T06:00:00Z"), now), 1);
  assertEquals(ecDaysLeft(new Date("2026-11-20T00:00:00Z"), now), 0);
});

Deno.test("renderTrialReminder: asunto con día y mes", () => {
  const { subject } = renderTrialReminder({
    shopName: "Taller Pablo",
    periodEnd: new Date("2026-11-29T15:00:00Z"),
    now: new Date("2026-11-22T13:00:00Z"),
  });
  assertEquals(subject, "Tu prueba de AntawaTec termina el 29 de noviembre");
});

Deno.test("renderTrialReminder: cuerpo con taller, fecha, precio y contacto", () => {
  const { html } = renderTrialReminder({
    shopName: "Taller Pablo",
    periodEnd: new Date("2026-11-29T15:00:00Z"),
    now: new Date("2026-11-22T13:00:00Z"),
  });
  assertStringIncludes(html, "Hola Taller Pablo,");
  assertStringIncludes(html, "<strong>29 de noviembre</strong> (en 7 días)");
  assertStringIncludes(html, "$25 al mes");
  assertStringIncludes(html, "https://app.antwt.com");
  assertStringIncludes(html, "Configuración → Suscripción");
  assertStringIncludes(html, "el acceso se suspende al vencer la prueba");
  assertStringIncludes(html, "soporte@antwt.com");
  assertStringIncludes(html, "0983924303");
});

Deno.test("renderTrialReminder: escapa el nombre del taller", () => {
  const { html } = renderTrialReminder({
    shopName: `<script>alert("x")</script> & Cía`,
    periodEnd: new Date("2026-11-29T15:00:00Z"),
  });
  assert(!html.includes("<script>"));
  assertStringIncludes(html, "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; Cía");
});

Deno.test("renderTrialReminder: nombre vacío cae a 'tu taller' y 'mañana'", () => {
  const { html } = renderTrialReminder({
    shopName: "   ",
    periodEnd: new Date("2026-11-23T20:00:00Z"),
    now: new Date("2026-11-22T13:00:00Z"),
  });
  assertStringIncludes(html, "Hola tu taller,");
  assertStringIncludes(html, "(mañana)");
});

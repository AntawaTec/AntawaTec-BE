// =============================================================================
// _shared/emailTemplates_test.ts
// Tests del render de correos (PURO, sin red). Cubren lo del lote L2 y el
// invariante que lo sostiene: `renderEmail` devuelve null para las plantillas
// que NO tienen correo — de eso depende que el drenado degrade en vez de
// mandar un mail vacío.
// =============================================================================

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { money, renderEmail, type EmailPayload } from "./emailTemplates.ts";

const payload = (over: Partial<EmailPayload> = {}): EmailPayload => ({
  customer_name: "María Ñandú",
  email: "maria@example.com",
  plate: "PBC-5251",
  make: "Chevrolet",
  model: "Sail",
  shop_name: "Taller Pablo",
  contact_phone: "+59322345678",
  contact_email: "taller@example.com",
  logo_url: null,
  address: "Av. Amazonas",
  ...over,
});

Deno.test("money: formato es-EC con símbolo y dos decimales", () => {
  assertEquals(money(1234.56), "$ 1.234,56");
  assertEquals(money(0), "$ 0,00");
  assertEquals(money(null), "$ 0,00");
});

Deno.test("work_in_process: asunto con el taller y aviso corto SIN adjunto anunciado", () => {
  const mail = renderEmail("work_in_process", payload())!;
  assert(mail);
  assertEquals(mail.subject, "Tu vehículo está en proceso — Taller Pablo");
  assertStringIncludes(mail.html, "Ya estamos trabajando en tu vehículo");
  assertStringIncludes(mail.html, "Chevrolet Sail PBC-5251");
  // El único de los cuatro que no lleva PDF: no debe prometer uno.
  assertEquals(mail.html.includes("PDF"), false);
});

Deno.test("delivery_completed: asunto de recibo y services_summary como lista", () => {
  const mail = renderEmail(
    "delivery_completed",
    payload({ services_summary: "- Cambio de aceite\n• Revisión de frenos\n\n" }),
  )!;
  assertEquals(mail.subject, "Recibo de entrega — Taller Pablo");
  assertStringIncludes(mail.html, "Adjuntamos el recibo de entrega");
  assertStringIncludes(mail.html, ">Cambio de aceite</li>");
  assertStringIncludes(mail.html, ">Revisión de frenos</li>");
  // Las viñetas tipeadas a mano no se duplican con las del <ul>.
  assertEquals(mail.html.includes(">- Cambio"), false);
});

Deno.test("delivery_completed: escapa el HTML del resumen (texto libre de la PWA)", () => {
  const mail = renderEmail(
    "delivery_completed",
    payload({ services_summary: "<script>alert(1)</script> & ok" }),
  )!;
  assertEquals(mail.html.includes("<script>"), false);
  assertStringIncludes(mail.html, "&lt;script&gt;");
  assertStringIncludes(mail.html, "&amp; ok");
});

Deno.test("delivery_completed: sin resumen usa el párrafo de fallback", () => {
  const mail = renderEmail("delivery_completed", payload({ services_summary: null }))!;
  assertStringIncludes(mail.html, "está en el recibo adjunto");
  assertEquals(mail.html.includes("<ul"), false);
});

Deno.test("vehicle_received: anuncia la orden de trabajo adjunta", () => {
  const mail = renderEmail("vehicle_received", payload())!;
  assertEquals(mail.subject, "Recibimos tu vehículo — Taller Pablo");
  assertStringIncludes(mail.html, "orden de trabajo</strong> en formato PDF");
});

Deno.test("renderEmail: las plantillas whatsapp-only siguen devolviendo null", () => {
  for (const t of ["appointment_confirmed", "appointment_reminder_24h", "vehicle_ready", "inexistente"]) {
    assertEquals(renderEmail(t, payload()), null, `esperaba null para ${t}`);
  }
});

Deno.test("fallbacks: sin nombre de taller ni de cliente el correo sigue siendo legible", () => {
  const mail = renderEmail("work_in_process", payload({ shop_name: null, customer_name: "  " }))!;
  assertEquals(mail.subject, "Tu vehículo está en proceso — Tu taller de confianza");
  assertStringIncludes(mail.html, "Hola cliente,");
});

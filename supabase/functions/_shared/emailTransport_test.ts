// =============================================================================
// _shared/emailTransport_test.ts
// Tests del cuerpo que ve Resend. Sin red: solo la parte PURA del transporte
// (`buildResendBody` / `pdfAttachment`). Existe porque un adjunto mal armado es
// un 422 que quema los 5 intentos de la fila y el cliente nunca se entera.
// =============================================================================

import { assert, assertEquals } from "jsr:@std/assert@1";
import { decodeBase64 } from "jsr:@std/encoding@1/base64";
import { buildResendBody, pdfAttachment } from "./emailTransport.ts";

const base = {
  to: "maria@example.com",
  subject: "Recibimos tu vehículo",
  html: "<p>hola</p>",
  fromAddr: "notificaciones@mail.antwt.com",
};

Deno.test("buildResendBody: sin adjuntos NO manda la clave attachments", () => {
  const body = buildResendBody(base);
  assertEquals(body.from, "notificaciones@mail.antwt.com");
  assertEquals(body.to, ["maria@example.com"]);
  assertEquals("attachments" in body, false);
  assertEquals("reply_to" in body, false);
});

Deno.test("buildResendBody: el display name es la identidad del taller", () => {
  const body = buildResendBody({ ...base, fromName: "  Taller Pablo  " });
  assertEquals(body.from, "Taller Pablo <notificaciones@mail.antwt.com>");
});

Deno.test("buildResendBody: reply_to solo si parece un email", () => {
  assertEquals(buildResendBody({ ...base, replyTo: "taller@example.com" }).reply_to, "taller@example.com");
  assertEquals("reply_to" in buildResendBody({ ...base, replyTo: "no-es-un-email" }), false);
  assertEquals("reply_to" in buildResendBody({ ...base, replyTo: "   " }), false);
  assertEquals("reply_to" in buildResendBody({ ...base, replyTo: null }), false);
});

Deno.test("buildResendBody: con adjuntos los pasa tal cual", () => {
  const att = pdfAttachment("OT-0042-orden.pdf", new Uint8Array([1, 2, 3, 4]));
  const body = buildResendBody({ ...base, attachments: [att] });
  const out = body.attachments as typeof att[];
  assertEquals(out.length, 1);
  assertEquals(out[0].filename, "OT-0042-orden.pdf");
  assertEquals(out[0].content_type, "application/pdf");
  assertEquals([...decodeBase64(out[0].content)], [1, 2, 3, 4]);
});

Deno.test("buildResendBody: descarta adjuntos vacíos (un PDF de 0 bytes sería un 422)", () => {
  const body = buildResendBody({
    ...base,
    attachments: [
      { filename: "", content: "abc" },
      { filename: "vacio.pdf", content: "" },
    ],
  });
  assertEquals("attachments" in body, false);
});

Deno.test("pdfAttachment: base64 estándar (sin saltos ni URL-safe)", () => {
  const att = pdfAttachment("x.pdf", new TextEncoder().encode("%PDF-1.7"));
  assert(/^[A-Za-z0-9+/]+={0,2}$/.test(att.content), `base64 raro: ${att.content}`);
  assertEquals(new TextDecoder().decode(decodeBase64(att.content)), "%PDF-1.7");
});

// Tests de toWhatsAppMsisdn: es la única puerta entre customers.whatsapp_number
// (tipeado a mano) y el proveedor. Las formas ecuatorianas son las 3 que la
// auditoría de prod (2026-07-30) encontró conviviendo; las internacionales son
// el caso del 2026-10-27 (clientes con WhatsApp de EE.UU. que no se podían guardar).
import { assertEquals } from "jsr:@std/assert@1";
import { toWhatsAppMsisdn } from "./phone.ts";

Deno.test("toWhatsAppMsisdn: móvil ecuatoriano en todas sus formas → 593…", () => {
  assertEquals(toWhatsAppMsisdn("+593991234567"), "593991234567"); // E.164
  assertEquals(toWhatsAppMsisdn("593991234567"), "593991234567"); // con país sin '+'
  assertEquals(toWhatsAppMsisdn("0991234567"), "593991234567"); // local con 0 troncal
  assertEquals(toWhatsAppMsisdn("991234567"), "593991234567"); // móvil pelado
  assertEquals(toWhatsAppMsisdn("+593 099 123 4567"), "593991234567"); // 0 de más tras el país
  assertEquals(toWhatsAppMsisdn("00593991234567"), "593991234567"); // prefijo de salida
  assertEquals(toWhatsAppMsisdn("(099) 123-4567"), "593991234567"); // separadores
  assertEquals(toWhatsAppMsisdn("+0991234567"), "593991234567"); // '+' de más sobre un local
});

Deno.test("toWhatsAppMsisdn: internacional con código de país explícito → E.164 sin '+'", () => {
  assertEquals(toWhatsAppMsisdn("+1 (954) 727-6658"), "19547276658"); // EE.UU., como lo pega el taller
  assertEquals(toWhatsAppMsisdn("+19547276658"), "19547276658");
  assertEquals(toWhatsAppMsisdn("0019547276658"), "19547276658"); // prefijo de salida
  assertEquals(toWhatsAppMsisdn("+1 416 555 0133"), "14165550133"); // Canadá (NANP)
  assertEquals(toWhatsAppMsisdn("+57 310 123 4567"), "573101234567"); // Colombia
  assertEquals(toWhatsAppMsisdn("+51 987 654 321"), "51987654321"); // Perú
  assertEquals(toWhatsAppMsisdn("+34 612 34 56 78"), "34612345678"); // España
  assertEquals(toWhatsAppMsisdn("+54 9 11 1234 5678"), "5491112345678"); // Argentina (13 dígitos)
});

Deno.test("toWhatsAppMsisdn: devuelve null en vez de adivinar", () => {
  assertEquals(toWhatsAppMsisdn(null), null);
  assertEquals(toWhatsAppMsisdn(undefined), null);
  assertEquals(toWhatsAppMsisdn(""), null);
  assertEquals(toWhatsAppMsisdn("   "), null);
  assertEquals(toWhatsAppMsisdn("09508123"), null); // EC incompleto (8 dígitos)
  assertEquals(toWhatsAppMsisdn("022345678"), null); // EC fijo, no móvil
  assertEquals(toWhatsAppMsisdn("+593 2 234 5678"), null); // EC fijo con país
  assertEquals(toWhatsAppMsisdn("19547276658"), null); // EE.UU. SIN '+': no se adivina país
  assertEquals(toWhatsAppMsisdn("+1 954 727 665"), null); // NANP incompleto
  assertEquals(toWhatsAppMsisdn("+1 054 727 6658"), null); // NANP: área no puede empezar en 0
  assertEquals(toWhatsAppMsisdn("00991234567"), null); // '00' + local: no es un país
  assertEquals(toWhatsAppMsisdn("+57 310 123"), null); // muy corto para un móvil con país
  assertEquals(toWhatsAppMsisdn("+57 310 123 4567 8901"), null); // más de 15 dígitos
  assertEquals(toWhatsAppMsisdn("no es un teléfono"), null);
});

// =============================================================================
// _shared/twilio_test.ts
// Tests unitarios del proveedor Twilio. Todo lo de acá es PURO o solo lee env:
// no toca red ni base (correr con `deno test --allow-env supabase/functions/`).
//
// Qué cubren, y por qué esas cuatro cosas: son los cuatro lugares donde un error
// silencioso costaría mensajes reales (o cobrados) sin dejar rastro:
//   1. el cuerpo de Messages.json (variables 1-based y prefijo whatsapp:+),
//   2. el corte previo a la red cuando falta el ContentSid,
//   3. el mapeo de estados de Twilio al vocabulario común de notification_log,
//   4. la validación de la firma X-Twilio-Signature (válida e inválida).
// =============================================================================

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1";
import {
  buildTwilioMessageForm,
  mapTwilioStatus,
  parseContentSids,
  twilioSignature,
  twilioWhatsAppAddress,
  verifyTwilioSignature,
} from "./twilio.ts";
import { sendWhatsApp } from "./whatsappTransport.ts";
import type { RenderedNotification } from "./notificationTemplates.ts";

// --- 1. Cuerpo de POST /Messages.json ---------------------------------------

Deno.test("buildTwilioMessageForm: ContentVariables 1-based en el orden de components", () => {
  const form = buildTwilioMessageForm({
    from: "whatsapp:+15551234567",
    msisdn: "593983926448",
    contentSid: "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    components: ["Andrés", "Chevrolet Aveo PBX-1234", "Taller Pablo · Tel. 0998765432"],
  });

  assertEquals(
    JSON.parse(form.get("ContentVariables")!),
    { "1": "Andrés", "2": "Chevrolet Aveo PBX-1234", "3": "Taller Pablo · Tel. 0998765432" },
  );
  assertEquals(form.get("ContentSid"), "HXaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
});

Deno.test("buildTwilioMessageForm: To lleva whatsapp:+ sobre el msisdn pelado", () => {
  const form = buildTwilioMessageForm({
    from: "whatsapp:+15551234567",
    msisdn: "593983926448", // toWhatsAppMsisdn() devuelve dígitos SIN '+'
    contentSid: "HX1",
    components: [],
  });
  assertEquals(form.get("To"), "whatsapp:+593983926448");
});

Deno.test("buildTwilioMessageForm: From se normaliza con el prefijo whatsapp:", () => {
  const sin = buildTwilioMessageForm({
    from: "+15551234567",
    msisdn: "593983926448",
    contentSid: "HX1",
    components: [],
  });
  const con = buildTwilioMessageForm({
    from: "whatsapp:+15551234567",
    msisdn: "593983926448",
    contentSid: "HX1",
    components: [],
  });
  assertEquals(sin.get("From"), "whatsapp:+15551234567");
  assertEquals(con.get("From"), "whatsapp:+15551234567");
  // Y nunca lo duplica.
  assertEquals(twilioWhatsAppAddress("whatsapp:+15551234567"), "whatsapp:+15551234567");
});

Deno.test("buildTwilioMessageForm: StatusCallback solo si está configurado", () => {
  const base = {
    from: "whatsapp:+15551234567",
    msisdn: "593983926448",
    contentSid: "HX1",
    components: ["x"],
  };
  assertEquals(buildTwilioMessageForm(base).has("StatusCallback"), false);
  assertEquals(buildTwilioMessageForm({ ...base, statusCallback: null }).has("StatusCallback"), false);
  assertEquals(
    buildTwilioMessageForm({ ...base, statusCallback: "https://x.functions.supabase.co/twilio-status-webhook" })
      .get("StatusCallback"),
    "https://x.functions.supabase.co/twilio-status-webhook",
  );
});

// --- 2. Mapa de Content SIDs y el corte previo a la red ----------------------

Deno.test("parseContentSids: JSON válido, basura y vacío", () => {
  assertEquals(parseContentSids('{"quote_ready":"HXabc"}'), { quote_ready: "HXabc" });
  assertEquals(parseContentSids("no es json"), {});
  assertEquals(parseContentSids(null), {});
  assertEquals(parseContentSids("[]"), {});
  // Descarta valores que no son string no-vacío (un JSON a medias no debe
  // producir un ContentSid inventado).
  assertEquals(parseContentSids('{"a":1,"b":"","c":"HXok"}'), { c: "HXok" });
});

const RENDERED: RenderedNotification = {
  text: "Hola Andrés…",
  components: ["Andrés", "Chevrolet Aveo PBX-1234", "Taller Pablo"],
};

/** Deja el entorno con Twilio elegido y credenciales completas (fuera de dry-run). */
function setTwilioEnv(contentSids: string) {
  Deno.env.set("WHATSAPP_PROVIDER", "twilio");
  Deno.env.set("WHATSAPP_DRY_RUN", "false");
  Deno.env.set("TWILIO_ACCOUNT_SID", "ACtest");
  Deno.env.set("TWILIO_AUTH_TOKEN", "token-de-prueba");
  Deno.env.set("TWILIO_WHATSAPP_FROM", "+15551234567");
  Deno.env.set("TWILIO_CONTENT_SIDS", contentSids);
}

function clearTwilioEnv() {
  for (
    const k of [
      "WHATSAPP_PROVIDER",
      "WHATSAPP_DRY_RUN",
      "TWILIO_ACCOUNT_SID",
      "TWILIO_AUTH_TOKEN",
      "TWILIO_WHATSAPP_FROM",
      "TWILIO_CONTENT_SIDS",
      "TWILIO_STATUS_CALLBACK_URL",
    ]
  ) Deno.env.delete(k);
}

Deno.test("sendWhatsApp/twilio: sin ContentSid falla SIN llamar a la red", async () => {
  setTwilioEnv('{"quote_ready":"HXabc"}');
  try {
    const res = await sendWhatsApp("0983926448", "vehicle_ready", RENDERED);
    assertFalse(res.ok);
    assertFalse(res.dryRun);
    assertEquals(res.error, "twilio: sin ContentSid para vehicle_ready");
    assertEquals(res.messageId, undefined);
  } finally {
    clearTwilioEnv();
  }
});

Deno.test("sendWhatsApp/twilio: sin credenciales completas se queda en dry-run", async () => {
  Deno.env.set("WHATSAPP_PROVIDER", "twilio");
  Deno.env.set("WHATSAPP_DRY_RUN", "false");
  // A propósito NO seteamos los secrets de Twilio: el doble candado tiene que
  // dejar el canal en sandbox en vez de mandar por Meta o reventar.
  Deno.env.set("WHATSAPP_TOKEN", "token-de-meta");
  Deno.env.set("WHATSAPP_PHONE_ID", "12345");
  try {
    const res = await sendWhatsApp("0983926448", "vehicle_ready", RENDERED);
    assert(res.ok);
    assert(res.dryRun);
  } finally {
    clearTwilioEnv();
    Deno.env.delete("WHATSAPP_TOKEN");
    Deno.env.delete("WHATSAPP_PHONE_ID");
  }
});

// --- 3. Mapeo de estados ----------------------------------------------------

Deno.test("mapTwilioStatus: los 7 estados de Twilio al vocabulario común", () => {
  assertEquals(mapTwilioStatus("queued"), "accepted");
  assertEquals(mapTwilioStatus("sending"), "accepted");
  assertEquals(mapTwilioStatus("sent"), "sent");
  assertEquals(mapTwilioStatus("delivered"), "delivered");
  assertEquals(mapTwilioStatus("read"), "read");
  assertEquals(mapTwilioStatus("failed"), "failed");
  // `undelivered` = Meta lo rechazó: para nosotros es lo mismo que failed.
  assertEquals(mapTwilioStatus("undelivered"), "failed");
  // Desconocidos y vacíos → null (el webhook responde 200 e ignora).
  assertEquals(mapTwilioStatus("receiving"), null);
  assertEquals(mapTwilioStatus(""), null);
  assertEquals(mapTwilioStatus(null), null);
});

// --- 4. Firma X-Twilio-Signature --------------------------------------------

Deno.test("twilioSignature: vector oficial de la doc de Twilio", async () => {
  // Ejemplo publicado por Twilio (Security → Validating requests). Si esto pasa,
  // el algoritmo (orden por clave + concat k+v sobre la URL, HMAC-SHA1, base64)
  // es el mismo que usa Twilio para firmar.
  const sig = await twilioSignature("12345", "https://example.com/myapp.php?foo=1&bar=2", {
    CallSid: "CA1234567890ABCDE",
    Caller: "+14158675310",
    Digits: "1234",
    From: "+14158675310",
    To: "+18005551212",
  });
  assertEquals(sig, "L/OH5YylLD5NRKLltdqwSvS0BnU=");
});

Deno.test("verifyTwilioSignature: acepta la firma correcta y rechaza la manipulada", async () => {
  const token = "auth-token-de-prueba";
  const url = "https://qldeexeshdzrithjagqq.functions.supabase.co/twilio-status-webhook";
  const params = {
    MessageSid: "SM0123456789abcdef0123456789abcdef",
    MessageStatus: "delivered",
    To: "whatsapp:+593983926448",
    From: "whatsapp:+15551234567",
  };
  const firma = await twilioSignature(token, url, params);

  assert(await verifyTwilioSignature(token, url, params, firma));
  // Sin header.
  assertFalse(await verifyTwilioSignature(token, url, params, null));
  // Firma de otro (token distinto).
  assertFalse(await verifyTwilioSignature("otro-token", url, params, firma));
  // Params manipulados: alguien intenta marcar como entregado otro mensaje.
  assertFalse(
    await verifyTwilioSignature(
      token,
      url,
      { ...params, MessageSid: "SMffffffffffffffffffffffffffffffff" },
      firma,
    ),
  );
  // URL distinta a la firmada (por eso el webhook prefiere TWILIO_STATUS_CALLBACK_URL).
  assertFalse(await verifyTwilioSignature(token, `${url}?x=1`, params, firma));
});

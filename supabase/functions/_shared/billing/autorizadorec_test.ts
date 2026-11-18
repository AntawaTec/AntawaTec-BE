// =============================================================================
// _shared/billing/autorizadorec_test.ts
// Tests del adaptador de AutorizadorEC con `fetch` FALSO: ninguna llamada sale a
// la API real. Cubren las decisiones que cuestan un comprobante duplicado o una
// factura mal marcada:
//   1. emisión: éxito, rechazo, timeout, 4xx/5xx, y la consulta previa por
//      idempotencyKey (existente autorizado → no reemite; rechazado → PUT).
//   2. firma del webhook (las dos cabeceras documentadas, con y sin prefijo).
//   3. normalización de respuestas (secuencial 001-001-…, errores, fechas).
//   4. alta de firma .p12 (multipart, X-Account-Key) sin filtrar el archivo.
// =============================================================================

import { assert, assertEquals, assertFalse, assertStringIncludes } from "jsr:@std/assert@1";
import {
  AutorizadorEcProvider,
  normalizeDocument,
  parseAutorizadorEcWebhook,
  parseIsoish,
  parseSeriesNumber,
  signAutorizadorEcBody,
  verifyAutorizadorEcSignature,
} from "./autorizadorec.ts";
import { buildInvoicePayload, type InvoicePayload } from "./sri.ts";

const BASE = "https://autorizador.test/api/v1";
const SK = "sk_test_ficticia";
const KEY = "11111111-2222-4333-8444-555555555555";
const CLAVE = "0911202601179999999000110010020000000431234567813";

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: BodyInit | null | undefined;
}

type Route = (call: Call) => Response | Promise<Response>;

/** fetch falso: enruta por "MÉTODO /ruta" y registra cada llamada. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const call: Call = { method, url, headers: new Headers(init?.headers), body: init?.body };
    calls.push(call);
    const path = url.replace(BASE, "");
    const route = routes[`${method} ${path}`];
    if (!route) return Promise.resolve(jsonRes(404, { statusCode: 404, message: "Not Found" }));
    return Promise.resolve(route(call));
  };
  return { fn, calls };
}

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(fetchFn: (i: string | URL | Request, init?: RequestInit) => Promise<Response>, extra = {}) {
  return new AutorizadorEcProvider({ baseUrl: `${BASE}/`, accountKey: "ak_test_ficticia", planId: 7, fetch: fetchFn, ...extra });
}

function payload(): InvoicePayload {
  return buildInvoicePayload(
    {
      id: KEY,
      buyer_id_type: "cedula",
      buyer_id_number: "1711111110",
      buyer_name: "Cliente Ficticio",
      payment_method: "01",
      issued_on: "2026-11-09",
    },
    [{ description: "Cambio de aceite", quantity: 1, unit_price: 40, tax_code: "4" }],
    { establecimiento: "001", punto_emision: "002", obligado_contabilidad: false, regimen: "general" },
  );
}

const authorizedDoc = {
  id: 43,
  tipoDocumento: "01",
  secuencial: "001-002-000000043",
  claveAcceso: CLAVE,
  estado: "AUTHORIZED",
  ambiente: "test",
  numeroAutorizacion: CLAVE,
  fechaAutorizacion: "2026-11-09T14:32:15.000Z",
  idempotencyKey: KEY,
  procesamiento: { modo: "sync", resultado: "authorized", encolado: false, errores: [] },
};

const LOOKUP = `GET /documents/by-idempotency-key/${KEY}`;

// --- 1. Emisión -------------------------------------------------------------------

Deno.test("emitInvoice: consulta por idempotencyKey (404) y emite síncrono → authorized", async () => {
  const { fn, calls } = fakeFetch({ "POST /documents/emit": () => jsonRes(201, authorizedDoc) });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "authorized");
  assertEquals(r.document?.secuencial, "000000043");
  assertEquals(r.document?.establecimiento, "001");
  assertEquals(r.document?.puntoEmision, "002");
  assertEquals(r.document?.accessKey, CLAVE);
  assertEquals(r.document?.authorizedAt, "2026-11-09T14:32:15.000Z");
  assertEquals(calls.map((c) => `${c.method} ${c.url.replace(BASE, "")}`), [LOOKUP, "POST /documents/emit"]);
  const post = calls[1];
  assertEquals(post.headers.get("X-API-Key"), SK);
  assertEquals(post.headers.get("X-Account-Key"), null);
  const sent = JSON.parse(String(post.body));
  assertEquals(sent.idempotencyKey, KEY);
  assertEquals(sent.tipoDocumento, "01");
});

Deno.test("emitInvoice: rechazo del SRI → rejected con el detalle del error", async () => {
  const { fn } = fakeFetch({
    "POST /documents/emit": () =>
      jsonRes(201, {
        ...authorizedDoc,
        estado: "REJECTED",
        numeroAutorizacion: null,
        procesamiento: {
          resultado: "rejected",
          errores: [{ codigo: "35", mensaje: "ARCHIVO NO CUMPLE ESTRUCTURA XML", detalle: "Campo identificacionComprador inválido", categoria: "client" }],
        },
      }),
  });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "rejected");
  assertEquals(r.document?.errors[0].code, "35");
  assertStringIncludes(r.message ?? "", "identificacionComprador");
});

Deno.test("emitInvoice: FAILED del proveedor (SRI sin respuesta, encolado) → processing, nunca failed", async () => {
  const { fn } = fakeFetch({
    "POST /documents/emit": () =>
      jsonRes(201, { ...authorizedDoc, estado: "FAILED", procesamiento: { resultado: "failed", encolado: true } }),
  });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "processing");
  assertEquals(r.document?.status, "FAILED");
});

Deno.test("emitInvoice: timeout de la emisión → processing", async () => {
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (String(input).includes("by-idempotency-key")) return Promise.resolve(jsonRes(404, {}));
    // Nunca responde: solo termina cuando el adaptador aborta.
    return new Promise((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  };
  const r = await provider(fn, { emitTimeoutMs: 20 }).emitInvoice(SK, payload());
  assertEquals(r.outcome, "processing");
  assertEquals(r.document, null);
});

Deno.test("emitInvoice: 5xx → processing; 400 → failed; 409 (duplicado por contenido) → failed", async () => {
  const p5 = await provider(fakeFetch({ "POST /documents/emit": () => jsonRes(500, { message: "boom" }) }).fn)
    .emitInvoice(SK, payload());
  assertEquals(p5.outcome, "processing");

  const p4 = await provider(
    fakeFetch({ "POST /documents/emit": () => jsonRes(400, { statusCode: 400, message: ["fechaEmision must be DD/MM/AAAA"] }) }).fn,
  ).emitInvoice(SK, payload());
  assertEquals(p4.outcome, "failed");
  assertStringIncludes(p4.message ?? "", "fechaEmision");

  const p9 = await provider(fakeFetch({ "POST /documents/emit": () => jsonRes(409, { message: "duplicado" }) }).fn)
    .emitInvoice(SK, payload());
  assertEquals(p9.outcome, "failed");
  assertStringIncludes(p9.message ?? "", "idéntico");
});

Deno.test("emitInvoice: si la consulta previa falla por red NO emite (processing)", async () => {
  const calls: string[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    return Promise.reject(new TypeError("network down"));
  };
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "processing");
  assertEquals(calls.length, 1, "solo la consulta; ningún POST a ciegas");
});

Deno.test("emitInvoice: credencial inválida (401 en la consulta) → failed", async () => {
  const { fn, calls } = fakeFetch({ [LOOKUP]: () => jsonRes(401, { message: "API Key invalida" }) });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "failed");
  assertEquals(calls.length, 1);
});

Deno.test("emitInvoice: documento ya AUTORIZADO con esa key → no reemite", async () => {
  const { fn, calls } = fakeFetch({ [LOOKUP]: () => jsonRes(200, authorizedDoc) });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "authorized");
  assert(r.notice);
  assertEquals(calls.length, 1);
});

Deno.test("emitInvoice: documento RECHAZADO con esa key → corrige con PUT /documents/{clave}/emit", async () => {
  const nueva = CLAVE.slice(0, 48) + "9";
  const { fn, calls } = fakeFetch({
    [LOOKUP]: () => jsonRes(200, { ...authorizedDoc, estado: "REJECTED", errors: [{ code: "35", message: "x" }] }),
    [`PUT /documents/${CLAVE}/emit`]: () => jsonRes(200, { ...authorizedDoc, claveAcceso: nueva }),
  });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "authorized");
  assertEquals(r.document?.accessKey, nueva, "se guarda la clave NUEVA que devuelve el PUT");
  assertEquals(calls.map((c) => c.method), ["GET", "PUT"]);
  assertEquals(JSON.parse(String(calls[1].body)).idempotencyKey, KEY);
});

Deno.test("emitInvoice: PUT 409 (no corregible) → processing (lo resuelve reconcile)", async () => {
  const { fn } = fakeFetch({
    [LOOKUP]: () => jsonRes(200, { ...authorizedDoc, estado: "FAILED" }),
    [`PUT /documents/${CLAVE}/emit`]: () => jsonRes(409, { message: "no corregible" }),
  });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "processing");
});

Deno.test("emitInvoice: documento en proceso (RECEIVED) → processing sin reemitir", async () => {
  const { fn, calls } = fakeFetch({ [LOOKUP]: () => jsonRes(200, { ...authorizedDoc, estado: "RECEIVED" }) });
  const r = await provider(fn).emitInvoice(SK, payload());
  assertEquals(r.outcome, "processing");
  assertEquals(calls.length, 1);
});

Deno.test("findDocument: 404 → null; documento → resultado normalizado", async () => {
  assertEquals(await provider(fakeFetch({}).fn).findDocument(SK, KEY), null);
  const r = await provider(fakeFetch({ [LOOKUP]: () => jsonRes(200, authorizedDoc) }).fn).findDocument(SK, KEY);
  assertEquals(r?.outcome, "authorized");
});

Deno.test("downloadFile: binario con X-API-Key", async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  const { fn, calls } = fakeFetch({
    [`GET /documents/${CLAVE}/files/ride`]: () => new Response(pdf, { status: 200, headers: { "content-type": "application/pdf" } }),
  });
  const bytes = await provider(fn).downloadFile(SK, CLAVE, "ride");
  assertEquals(Array.from(bytes), Array.from(pdf));
  assertEquals(calls[0].headers.get("X-API-Key"), SK);
});

// --- Empresas y firma ---------------------------------------------------------------

Deno.test("createCompany: X-Account-Key, planId, modo platform y webhook", async () => {
  const { fn, calls } = fakeFetch({
    "POST /client/companies": () => jsonRes(201, { id: 10, apiKey: "sk_nueva_ficticia", env: "test" }),
  });
  const ref = await provider(fn).createCompany({
    ruc: "1799999990001",
    razonSocial: "Taller Ficticio S.A.",
    direccionMatriz: "Calle Falsa 123",
    environment: "test",
    establecimiento: "001",
    webhookUrl: "https://example.test/functions/v1/invoice-webhook",
    webhookSecret: "whsec_ficticio",
  });
  assertEquals(ref, { companyId: "10", apiKey: "sk_nueva_ficticia" });
  assertEquals(calls[0].headers.get("X-Account-Key"), "ak_test_ficticia");
  const sent = JSON.parse(String(calls[0].body));
  assertEquals(sent.planId, 7);
  assertEquals(sent.sequentialMode, "platform");
  assertEquals(sent.accessKeyMode, "platform");
  assertEquals(sent.env, "test");
  assertEquals(sent.webhookSecret, "whsec_ficticio");
});

Deno.test("findCompanyByRuc: encuentra la empresa con su apiKey; null si no está", async () => {
  const list = [{ id: 3, ruc: "0999999999001", apiKey: "sk_otra" }, { id: 10, ruc: "1799999990001", apiKey: "sk_esta" }];
  const p = provider(fakeFetch({ "GET /client/companies": () => jsonRes(200, list) }).fn);
  assertEquals(await p.findCompanyByRuc("1799999990001"), { companyId: "10", apiKey: "sk_esta" });
  assertEquals(await p.findCompanyByRuc("1760000070001"), null);
});

Deno.test("ensureSeries: crea el punto de emisión que falta en el establecimiento", async () => {
  const { fn, calls } = fakeFetch({
    "GET /client/companies/10/establishments": () =>
      jsonRes(200, [{ id: 1, code: "001", isMain: true, emissionPoints: [{ id: 5, code: "001" }] }]),
    "POST /client/companies/10/emission-points": () => jsonRes(201, { id: 6, code: "002" }),
  });
  await provider(fn).ensureSeries("10", { establecimiento: "001", puntoEmision: "002", address: "x", name: "x" });
  assertEquals(calls.map((c) => c.method), ["GET", "POST"]);
  assertEquals(JSON.parse(String(calls[1].body)), { code: "002", establecimiento: "001", description: "Punto 002" });
});

Deno.test("uploadCertificate: multipart con file + password; devuelve vencimiento", async () => {
  const { fn, calls } = fakeFetch({
    "POST /client/companies/10/certificates": () =>
      jsonRes(201, {
        certificate: { id: 15, expiresAt: "2027-05-15", subjectCn: "NOMBRE FICTICIO" },
        validation: { validTo: "2027-05-15T00:00:00.000Z" },
      }),
  });
  const cert = await provider(fn).uploadCertificate("10", new Uint8Array([1, 2, 3]), "clave-ficticia");
  assertEquals(cert, { expiresAt: "2027-05-15T00:00:00.000Z", subject: "NOMBRE FICTICIO" });
  const form = calls[0].body as FormData;
  assert(form instanceof FormData);
  assertEquals(form.get("password"), "clave-ficticia");
  assert(form.get("file") instanceof Blob);
  assertEquals(calls[0].headers.get("X-Account-Key"), "ak_test_ficticia");
});

Deno.test("uploadCertificate: el error del proveedor no incluye la clave enviada", async () => {
  const { fn } = fakeFetch({
    "POST /client/companies/10/certificates": () => jsonRes(400, { message: "Contraseña del certificado incorrecta" }),
  });
  try {
    await provider(fn).uploadCertificate("10", new Uint8Array([1]), "clave-secreta-123");
    throw new Error("debía lanzar");
  } catch (e) {
    const msg = String((e as Error).message);
    assertStringIncludes(msg, "400");
    assertFalse(msg.includes("clave-secreta-123"));
  }
});

// --- 2. Firma del webhook -------------------------------------------------------------

Deno.test("verifyAutorizadorEcSignature: X-AutorizadorEC-Signature con prefijo sha256=", async () => {
  const body = JSON.stringify({ event: "document.authorized", data: { claveAcceso: CLAVE } });
  const sig = await signAutorizadorEcBody("whsec_ficticio", body);
  assert(sig.startsWith("sha256="));
  assert(await verifyAutorizadorEcSignature(body, new Headers({ "X-AutorizadorEC-Signature": sig }), "whsec_ficticio"));
});

Deno.test("verifyAutorizadorEcSignature: X-Webhook-Signature con hex pelado", async () => {
  const body = '{"event":"document.rejected"}';
  const hex = (await signAutorizadorEcBody("whsec_ficticio", body)).slice("sha256=".length);
  assert(await verifyAutorizadorEcSignature(body, new Headers({ "X-Webhook-Signature": hex }), "whsec_ficticio"));
});

Deno.test("verifyAutorizadorEcSignature: rechaza firma inválida, body alterado, sin cabecera o sin secreto", async () => {
  const body = '{"event":"document.authorized"}';
  const sig = await signAutorizadorEcBody("whsec_ficticio", body);
  assertFalse(await verifyAutorizadorEcSignature(body, new Headers({ "X-AutorizadorEC-Signature": sig }), "otro_secreto"));
  assertFalse(await verifyAutorizadorEcSignature(body + " ", new Headers({ "X-AutorizadorEC-Signature": sig }), "whsec_ficticio"));
  assertFalse(await verifyAutorizadorEcSignature(body, new Headers(), "whsec_ficticio"));
  assertFalse(await verifyAutorizadorEcSignature(body, new Headers({ "X-AutorizadorEC-Signature": sig }), ""));
  assertFalse(await verifyAutorizadorEcSignature(body, new Headers({ "X-AutorizadorEC-Signature": "sha256=abc" }), "whsec_ficticio"));
});

Deno.test("parseAutorizadorEcWebhook: authorized / rejected / failed final / informativo", () => {
  const a = parseAutorizadorEcWebhook({ event: "document.authorized", data: authorizedDoc });
  assertEquals(a?.outcome, "authorized");
  assertEquals(a?.document.idempotencyKey, KEY);

  const r = parseAutorizadorEcWebhook({
    event: "document.rejected",
    data: { claveAcceso: CLAVE, estado: "REJECTED", errores: [{ codigo: "45", mensaje: "ERROR SECUENCIAL REGISTRADO", detalle: "…" }] },
  });
  assertEquals(r?.outcome, "rejected");
  assertEquals(r?.document.errors[0].code, "45");

  const f = parseAutorizadorEcWebhook({ event: "document.failed", data: { claveAcceso: CLAVE, estado: "FAILED" } });
  assertEquals(f?.outcome, "failed");
  assert(f?.finalFailure);

  const info = parseAutorizadorEcWebhook({ event: "document.received", data: { claveAcceso: CLAVE, estado: "RECEIVED" } });
  assertEquals(info?.outcome, null);

  assertEquals(parseAutorizadorEcWebhook({ event: "document.authorized", data: {} }), null);
  assertEquals(parseAutorizadorEcWebhook("nope"), null);
});

// --- 3. Normalización -------------------------------------------------------------------

Deno.test("parseSeriesNumber / parseIsoish / normalizeDocument", () => {
  assertEquals(parseSeriesNumber("001-002-000000043", null, null), {
    establecimiento: "001",
    puntoEmision: "002",
    secuencial: "000000043",
  });
  assertEquals(parseSeriesNumber("43", "003", "004"), { establecimiento: "003", puntoEmision: "004", secuencial: "000000043" });
  assertEquals(parseSeriesNumber(undefined, null, null).secuencial, null);

  assertEquals(parseIsoish("2026-03-06T14:32:15.000Z"), "2026-03-06T14:32:15.000Z");
  assertEquals(parseIsoish("06/03/2026, 14:35:20"), "2026-03-06T19:35:20.000Z"); // hora de Ecuador
  assertEquals(parseIsoish("2027-05-15"), "2027-05-15T00:00:00.000Z");
  assertEquals(parseIsoish("basura"), null);

  const d = normalizeDocument({ claveAcceso: "123", estado: "authorized", errors: [{ code: "SYS001", message: "x", category: "system" }] });
  assertEquals(d.accessKey, null, "una clave que no tiene 49 dígitos no se guarda");
  assertEquals(d.status, "AUTHORIZED");
  assertEquals(d.errors[0].category, "system");
});

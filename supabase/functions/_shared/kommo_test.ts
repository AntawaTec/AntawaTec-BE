// =============================================================================
// _shared/kommo_test.ts
// Tests de la sincronización con Kommo, sin red (fetch inyectado). Cubren las
// guardas que protegen el CRM de un `lid` que llega por una URL pública, y los
// reintentos.  deno test --allow-env supabase/functions/
// =============================================================================

import { assertEquals } from "jsr:@std/assert@1";
import {
  KOMMO_PIPELINE_ID,
  KOMMO_STATUS_TRIAL,
  KOMMO_STATUS_WON,
  moveLead,
  parseLeadId,
} from "./kommo.ts";

type Call = { url: string; method: string; body?: string };

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) return Promise.reject(new Error("sin respuesta programada"));
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }) as typeof fetch;
  return { impl, calls };
}

const lead = (pipeline_id: number, status_id: number) =>
  new Response(JSON.stringify({ id: 1, pipeline_id, status_id }), { status: 200 });

const deps = (f: typeof fetch) => ({
  fetch: f,
  sleep: () => Promise.resolve(),
  token: "t",
  baseUrl: "https://kommo.test/api/v4/",
});

const trial = { leadId: 123, statusId: KOMMO_STATUS_TRIAL, price: 25 };

Deno.test("parseLeadId: solo enteros positivos", () => {
  assertEquals(parseLeadId("12345"), 12345);
  assertEquals(parseLeadId(" 77 "), 77);
  assertEquals(parseLeadId(9), 9);
  for (const bad of ["", "0", "12a", "-3", "1.5", "1 OR 1=1", null, undefined, {}, "9".repeat(16)]) {
    assertEquals(parseLeadId(bad), null);
  }
});

Deno.test("moveLead: sin token no llama a nadie", async () => {
  const f = fakeFetch([]);
  assertEquals(await moveLead(trial, { ...deps(f.impl), token: "" }), "disabled");
  assertEquals(f.calls.length, 0);
});

Deno.test("moveLead: mueve el lead con status y precio", async () => {
  const f = fakeFetch([lead(KOMMO_PIPELINE_ID, 111), new Response("{}", { status: 200 })]);
  assertEquals(await moveLead(trial, deps(f.impl)), "moved");
  assertEquals(f.calls.map((c) => c.method), ["GET", "PATCH"]);
  assertEquals(f.calls[1].url, "https://kommo.test/api/v4/leads/123");
  assertEquals(JSON.parse(f.calls[1].body!), { status_id: KOMMO_STATUS_TRIAL, price: 25 });
});

Deno.test("moveLead: no toca leads inexistentes, de otro pipeline, ganados o ya en la etapa", async () => {
  const cases = [
    new Response(null, { status: 204 }),
    new Response("{}", { status: 404 }),
    lead(999, 111),
    lead(KOMMO_PIPELINE_ID, KOMMO_STATUS_WON),
    lead(KOMMO_PIPELINE_ID, KOMMO_STATUS_TRIAL),
  ];
  for (const res of cases) {
    const f = fakeFetch([res]);
    assertEquals(await moveLead(trial, deps(f.impl)), "skipped");
    assertEquals(f.calls.length, 1); // nunca llegó al PATCH
  }
});

Deno.test("moveLead: reintenta 5xx / 429 / red y después mueve", async () => {
  const f = fakeFetch([
    new Response("", { status: 503 }),
    new Error("red"),
    lead(KOMMO_PIPELINE_ID, 111),
    new Response("", { status: 429 }),
    new Response("{}", { status: 200 }),
  ]);
  assertEquals(await moveLead(trial, deps(f.impl)), "moved");
  assertEquals(f.calls.length, 5);
});

Deno.test("moveLead: tres fallos seguidos = failed (reintentable más tarde)", async () => {
  const f = fakeFetch([
    new Response("", { status: 500 }),
    new Response("", { status: 500 }),
    new Response("", { status: 500 }),
  ]);
  assertEquals(await moveLead(trial, deps(f.impl)), "failed");
  assertEquals(f.calls.length, 3);
});

Deno.test("moveLead: token inválido = failed, no skipped", async () => {
  const f = fakeFetch([new Response("", { status: 401 })]);
  assertEquals(await moveLead(trial, deps(f.impl)), "failed");
});

// =============================================================================
// _shared/paginate_test.ts
// Tests del helper de lectura paginada. Todo PURO: sin red, sin base, sin env
// (corre con `deno test --allow-env supabase/functions/`, el comando del CI).
//
// El builder de postgrest-js se reemplaza por un fake a mano (`fakeTable`) que
// registra cada `.order()`/`.range()` y devuelve el tramo pedido de un arreglo.
//
// Qué cubren y por qué: el bug que motivó el helper fue un corte SILENCIOSO a
// 1000 filas; los casos apuntan a que nunca más se pierda ni se duplique una fila
// ni se trague un error:
//   1. una sola página corta = una sola llamada,
//   2. página exactamente llena ⇒ pide la siguiente (y esa vuelve vacía),
//   3. varias páginas concatenadas en orden,
//   4. un error en cualquier página se propaga con su mensaje y el nº de página,
//   5. siempre ordena (por `id` salvo que se pida otra columna),
//   6. los frenos: pageSize > max_rows y maxPages.
// =============================================================================

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1";
import { MAX_PAGE_SIZE, type PageQuery, type PageResult, selectAll } from "./paginate.ts";

interface Call {
  order: [string, { ascending?: boolean } | undefined];
  range: [number, number];
}

// Fake del builder: cada `makeQuery()` devuelve un builder nuevo (como el real),
// que anota su `.order()` y su `.range()` en `calls`. Si `failAt` coincide con el
// índice de la llamada, esa página devuelve `{ data: null, error: { message } }`.
function fakeTable<T>(rows: T[], failAt?: number) {
  const calls: Call[] = [];
  const makeQuery = (): PageQuery<T> => {
    let order: Call["order"] = ["<sin order>", undefined];
    const builder: PageQuery<T> = {
      order(column, options) {
        order = [column, options];
        return builder;
      },
      range(from, to) {
        const idx = calls.length;
        calls.push({ order, range: [from, to] });
        const res: PageResult<T> = idx === failAt
          ? { data: null, error: { message: "boom" } }
          : { data: rows.slice(from, to + 1), error: null };
        return Promise.resolve(res);
      },
    };
    return builder;
  };
  return { calls, makeQuery };
}

const seq = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i }));

// --- 1. Una página corta -----------------------------------------------------

Deno.test("selectAll: 3 filas con pageSize 10 → una sola llamada", async () => {
  const t = fakeTable(seq(3));
  const out = await selectAll(t.makeQuery, { pageSize: 10 });
  assertEquals(out, seq(3));
  assertEquals(t.calls.length, 1);
  assertEquals(t.calls[0].range, [0, 9]);
});

// --- 2. Página exactamente llena ---------------------------------------------

Deno.test("selectAll: exactamente 10 filas con pageSize 10 → 2 llamadas, 10 filas", async () => {
  const t = fakeTable(seq(10));
  const out = await selectAll(t.makeQuery, { pageSize: 10 });
  assertEquals(out.length, 10);
  assertEquals(out, seq(10));
  assertEquals(t.calls.map((c) => c.range), [[0, 9], [10, 19]]);
});

// --- 3. Varias páginas, orden preservado -------------------------------------

Deno.test("selectAll: 23 filas con pageSize 10 → 3 llamadas, orden preservado", async () => {
  const t = fakeTable(seq(23));
  const out = await selectAll(t.makeQuery, { pageSize: 10 });
  assertEquals(out, seq(23));
  assertEquals(t.calls.map((c) => c.range), [[0, 9], [10, 19], [20, 29]]);
});

// --- 4. Error en una página --------------------------------------------------

Deno.test("selectAll: error en la página 1 se propaga con el mensaje y la página", async () => {
  const t = fakeTable(seq(30), 1);
  const err = await assertRejects(() => selectAll(t.makeQuery, { pageSize: 10 }), Error);
  assertStringIncludes(err.message, "boom");
  assertStringIncludes(err.message, "página 1");
  // No sigue pidiendo páginas después del error.
  assertEquals(t.calls.length, 2);
});

// --- 5. Siempre ordena -------------------------------------------------------

Deno.test("selectAll: toda página se pide ordenada por id ascendente", async () => {
  const t = fakeTable(seq(23));
  await selectAll(t.makeQuery, { pageSize: 10 });
  for (const c of t.calls) assertEquals(c.order, ["id", { ascending: true }]);
});

Deno.test("selectAll: respeta orderBy explícito", async () => {
  const t = fakeTable(seq(15));
  await selectAll(t.makeQuery, { pageSize: 10, orderBy: "created_at" });
  assertEquals(t.calls.length, 2);
  for (const c of t.calls) assertEquals(c.order, ["created_at", { ascending: true }]);
});

// --- 6. Frenos ---------------------------------------------------------------

Deno.test("selectAll: pageSize mayor que max_rows lanza sin consultar", async () => {
  const t = fakeTable(seq(3));
  await assertRejects(
    () => selectAll(t.makeQuery, { pageSize: MAX_PAGE_SIZE + 1 }),
    Error,
    "pageSize 1001",
  );
  assertEquals(t.calls.length, 0);
});

Deno.test("selectAll: superar maxPages lanza", async () => {
  const t = fakeTable(seq(30));
  await assertRejects(
    () => selectAll(t.makeQuery, { pageSize: 10, maxPages: 2 }),
    Error,
    "superó 2 páginas",
  );
  assertEquals(t.calls.length, 2);
});

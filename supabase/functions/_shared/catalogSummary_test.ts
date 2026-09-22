// =============================================================================
// _shared/catalogSummary_test.ts
// Casos PORTADOS de AntawaTec-FE/src/lib/data/catalog.test.ts (los que prueban
// buildCatalogTree y summarizeSelections; los del reconciliador no aplican acá,
// el BE solo lee) + los del contrato nuevo de comentarios por módulo.
//
// Estos tests son el contrato de que el PDF del correo dice EXACTAMENTE lo mismo
// que la vista imprimible del FE. Si uno de los dos lados cambia el formato sin
// el otro, el cliente recibe dos documentos distintos del mismo trabajo.
// =============================================================================

import { assertEquals } from "jsr:@std/assert@1";
import {
  buildCatalogTree,
  summarizeSelections,
  type CatalogItem,
  type CatalogSelection,
} from "./catalogSummary.ts";

const item = (id: string, over: Partial<CatalogItem> = {}): CatalogItem => ({
  id,
  module: "mantenimiento",
  parent_id: null,
  name: `item-${id}`,
  selection_type: "boolean",
  enum_options: null,
  sort_order: 0,
  ...over,
});

const sel = (
  catalog_item_id: string,
  selected_value: string | null = null,
  notes: string | null = null,
): CatalogSelection => ({ catalog_item_id, selected_value, notes });

// --- buildCatalogTree --------------------------------------------------------

Deno.test("buildCatalogTree: agrupa hijos bajo su padre y ordena por sort_order", () => {
  const tree = buildCatalogTree([
    item("h2", { parent_id: "r1", sort_order: 2 }),
    item("r2", { sort_order: 2 }),
    item("h1", { parent_id: "r1", sort_order: 1 }),
    item("r1", { sort_order: 1 }),
  ]);
  assertEquals(tree.map((n) => n.id), ["r1", "r2"]);
  assertEquals(tree[0].children.map((n) => n.id), ["h1", "h2"]);
  assertEquals(tree[1].children.length, 0);
});

// --- summarizeSelections (portados del FE) -----------------------------------

Deno.test("summarizeSelections: sin selecciones devuelve cadena vacía", () => {
  assertEquals(summarizeSelections([item("r1")], []), "");
});

Deno.test("summarizeSelections: agrupa por módulo en orden de UI, raíz con valor, descendientes en línea y notas con sangría", () => {
  const items = [
    // Enderezada primero en el input para probar que manda el orden de CATALOG_MODULES.
    item("e1", { module: "enderezada_pintura", name: "Capó", selection_type: "enum_select", sort_order: 1 }),
    item("r1", { name: "ABC del motor", sort_order: 2 }),
    item("r1a", { parent_id: "r1", name: "Filtro de aire", sort_order: 1 }),
    item("r1b", { parent_id: "r1", name: "Bujías", sort_order: 2 }),
    item("r0", { name: "Aceite y filtro", sort_order: 1 }),
    item("rX", { name: "No elegido", sort_order: 3 }),
  ];
  const out = summarizeSelections(items, [
    sel("e1", "Pintura"),
    sel("r1", null, "cliente trae repuestos"),
    sel("r1a"),
    sel("r1b", null, "NGK"),
    sel("r0"),
  ]);
  assertEquals(
    out,
    [
      "Mantenimiento",
      "- Aceite y filtro",
      "- ABC del motor — Filtro de aire · Bujías",
      "  Nota: cliente trae repuestos",
      "  Nota (Bujías): NGK",
      "Enderezada y Pintura",
      "- Capó: Pintura",
    ].join("\n"),
  );
});

Deno.test("summarizeSelections: un hijo de raíz NO seleccionada no aparece", () => {
  const items = [item("r1", { name: "Frenos" }), item("h1", { parent_id: "r1", name: "Pastillas" })];
  assertEquals(summarizeSelections(items, [sel("h1")]), "");
});

// --- contrato nuevo: comentarios por módulo (0039) ---------------------------

Deno.test("summarizeSelections: el comentario del módulo va al final de su bloque", () => {
  const items = [item("r1", { name: "Frenos", sort_order: 1 })];
  const out = summarizeSelections(items, [sel("r1")], { mantenimiento: "revisar ruido al frenar" });
  assertEquals(out, ["Mantenimiento", "- Frenos", "  Comentarios: revisar ruido al frenar"].join("\n"));
});

Deno.test("summarizeSelections: un módulo con SOLO comentario igual se imprime", () => {
  const out = summarizeSelections([], [], { reparacion: "el cliente pidió presupuesto aparte" });
  assertEquals(out, ["Reparación", "  Comentarios: el cliente pidió presupuesto aparte"].join("\n"));
});

Deno.test("summarizeSelections: comentario en blanco se ignora (no imprime el módulo)", () => {
  assertEquals(summarizeSelections([], [], { mantenimiento: "   \n  " }), "");
});

Deno.test("summarizeSelections: el comentario multilínea se conserva tal cual", () => {
  const out = summarizeSelections([], [], { mantenimiento: "línea 1\nlínea 2" });
  assertEquals(out, ["Mantenimiento", "  Comentarios: línea 1", "línea 2"].join("\n"));
});

Deno.test("summarizeSelections: comentarios de varios módulos respetan el orden de UI", () => {
  const out = summarizeSelections([], [], {
    enderezada_pintura: "pintar solo el capó",
    mantenimiento: "aceite sintético",
  });
  assertEquals(out, [
    "Mantenimiento",
    "  Comentarios: aceite sintético",
    "Enderezada y Pintura",
    "  Comentarios: pintar solo el capó",
  ].join("\n"));
});

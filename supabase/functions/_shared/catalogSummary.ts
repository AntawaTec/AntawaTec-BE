// =============================================================================
// _shared/catalogSummary.ts
// ESPEJO de AntawaTec-FE/src/lib/data/catalog.ts (buildCatalogTree +
// summarizeSelections + CATALOG_MODULES). PURO, sin I/O.
//
// Por qué duplicado y no compartido: los dos repos no comparten runtime (Deno vs
// Next) ni bundler, y el texto de "Trabajos" tiene que salir IDÉNTICO en la vista
// imprimible del FE y en el PDF que el BE adjunta al correo — si divergen, el
// cliente recibe dos documentos distintos del mismo trabajo. Regla operativa: un
// cambio acá es un cambio ALLÁ en el mismo lote (y al revés).
//
// CONTRATO v2 (comentarios por módulo, migración 0039 + FE en paralelo):
// `summarizeSelections` acepta un 3er parámetro opcional con el comentario libre
// por módulo (`work_order_module_comments`). Por cada módulo que tenga raíces
// seleccionadas O comentario se imprime su label; el comentario va al final del
// bloque del módulo como "  Comentarios: <texto>", con el texto TAL CUAL (puede
// ser multilínea: el único trim es el de la comprobación de vacío). Un módulo con
// solo comentario y sin selecciones también se imprime.
// =============================================================================

export type CatalogModule = "mantenimiento" | "reparacion" | "enderezada_pintura";

export interface CatalogItem {
  id: string;
  module: string; // CatalogModule; `string` para tolerar módulos nuevos del seed
  parent_id: string | null;
  name: string;
  selection_type?: string | null;
  enum_options?: string[] | null;
  sort_order: number;
}

export interface CatalogSelection {
  catalog_item_id: string;
  selected_value?: string | null;
  notes?: string | null;
}

export interface CatalogNode extends CatalogItem {
  children: CatalogNode[];
}

/** Comentario libre por módulo (0039). Módulo ausente o vacío = sin comentario. */
export type ModuleComments = Partial<Record<CatalogModule, string | null>>;

// Módulos en orden de UI (labels ES). Fuente única del orden del resumen.
export const CATALOG_MODULES: { value: CatalogModule; label: string }[] = [
  { value: "mantenimiento", label: "Mantenimiento" },
  { value: "reparacion", label: "Reparación" },
  { value: "enderezada_pintura", label: "Enderezada y Pintura" },
];

// Arma el árbol a partir de la lista plana. Ordena raíces y hermanos por
// sort_order; un hijo cuyo padre no vino en la lista se descarta.
export function buildCatalogTree(items: CatalogItem[]): CatalogNode[] {
  const nodes = new Map<string, CatalogNode>(items.map((it) => [it.id, { ...it, children: [] }]));
  const roots: CatalogNode[] = [];
  for (const node of nodes.values()) {
    if (node.parent_id === null) {
      roots.push(node);
    } else {
      nodes.get(node.parent_id)?.children.push(node);
    }
  }
  const bySort = (a: CatalogNode, b: CatalogNode) => a.sort_order - b.sort_order;
  for (const node of nodes.values()) node.children.sort(bySort);
  return roots.sort(bySort);
}

/**
 * Resumen en TEXTO PLANO de las selecciones de una orden, agrupado por módulo y
 * en el orden del catálogo: raíz con su valor, descendientes elegidos en la misma
 * línea unidos con " · ", notas debajo con sangría, y el comentario del módulo al
 * final del bloque. Devuelve "" si no hay nada que mostrar.
 */
export function summarizeSelections(
  items: CatalogItem[],
  selections: CatalogSelection[],
  comments?: ModuleComments,
): string {
  const selByItem = new Map(selections.map((s) => [s.catalog_item_id, s]));
  const collectDescendants = (node: CatalogNode): CatalogNode[] =>
    node.children.flatMap((c) => [c, ...collectDescendants(c)]);
  const withValue = (node: CatalogNode): string => {
    const v = selByItem.get(node.id)?.selected_value;
    return v ? `${node.name}: ${v}` : node.name;
  };
  const lines: string[] = [];
  for (const m of CATALOG_MODULES) {
    const roots = buildCatalogTree(items.filter((it) => it.module === m.value)).filter((r) =>
      selByItem.has(r.id)
    );
    // El comentario se guarda tal cual; el trim es SOLO para decidir si existe.
    const comment = comments?.[m.value] ?? "";
    const hasComment = comment.trim().length > 0;
    if (roots.length === 0 && !hasComment) continue;
    lines.push(m.label);
    for (const root of roots) {
      const chosen = collectDescendants(root).filter((n) => selByItem.has(n.id));
      lines.push(
        `- ${withValue(root)}${chosen.length > 0 ? ` — ${chosen.map(withValue).join(" · ")}` : ""}`,
      );
      for (const n of [root, ...chosen]) {
        const notes = selByItem.get(n.id)?.notes;
        if (notes) lines.push(`  Nota${n.id === root.id ? "" : ` (${n.name})`}: ${notes}`);
      }
    }
    if (hasComment) lines.push(`  Comentarios: ${comment}`);
  }
  return lines.join("\n");
}

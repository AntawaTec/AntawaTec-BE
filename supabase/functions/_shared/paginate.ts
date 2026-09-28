// =============================================================================
// _shared/paginate.ts
// Lectura COMPLETA de una query por páginas.
//
// PostgREST corta toda respuesta en `max_rows = 1000` (supabase/config.toml) sin
// error ni aviso: un `.select()` sin `.range()` sobre una tabla que crece devuelve
// las primeras 1000 filas en orden de heap y calla. Así se perdieron en silencio
// los avisos de la orden de todo lo creado/movido desde el 2026-09-22 (tras el
// import de Zoho, `work_orders` pasó las 1000 filas y lo nuevo quedó siempre fuera).
//
// Reglas del helper:
//   * Orden TOTAL y estable (`id` por defecto): sin `.order()` las páginas de
//     `.range()` no son deterministas y una fila puede caer en dos o en ninguna.
//   * `error` SIEMPRE se lee y se lanza: nunca más un `{ data }` que traga el fallo.
//   * `pageSize` nunca por encima de `max_rows`: una página mayor se truncaría
//     igual en silencio y la condición de corte ("página corta = fin") mentiría.
//   * `maxPages` es un freno de mano: si una query devuelve cientos de miles de
//     filas, casi seguro le falta un filtro; mejor un 500 legible que un timeout.
//
// PURO respecto del cliente: no importa supabase-js, recibe una fábrica de query
// con un tipo estructural mínimo (el builder real de postgrest-js lo cumple, y un
// fake de test también).
// =============================================================================

// = max_rows de PostgREST; una página mayor se truncaría en silencio.
export const MAX_PAGE_SIZE = 1000;
export const DEFAULT_PAGE_SIZE = 500;

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

// Tipo estructural mínimo del builder de postgrest-js (alcanza para el helper y
// para un fake de test).
export interface PageQuery<T> {
  order(column: string, options?: { ascending?: boolean }): PageQuery<T>;
  range(from: number, to: number): PromiseLike<PageResult<T>>;
}

export interface SelectAllOptions {
  pageSize?: number;
  orderBy?: string;
  maxPages?: number;
}

/**
 * Trae TODAS las filas de la query, página por página, ordenadas por `orderBy`.
 *
 * `makeQuery` es una FÁBRICA, no un builder: el builder de postgrest-js es mutable
 * (cada `.order()`/`.range()` lo modifica), así que cada página arranca de uno
 * fresco con el mismo select y los mismos filtros.
 *
 * Lanza si PostgREST devuelve error en cualquier página, si `pageSize` está fuera
 * de 1..MAX_PAGE_SIZE o si se superan `maxPages` páginas.
 */
export async function selectAll<T>(
  makeQuery: () => PageQuery<T>,
  opts: SelectAllOptions = {},
): Promise<T[]> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const orderBy = opts.orderBy ?? "id";
  const maxPages = opts.maxPages ?? 200;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`selectAll: pageSize ${pageSize} fuera de 1..${MAX_PAGE_SIZE}`);
  }

  const out: T[] = [];
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      throw new Error(`selectAll: superó ${maxPages} páginas de ${pageSize}; ¿falta un filtro?`);
    }
    const from = page * pageSize;
    const { data, error } = await makeQuery()
      .order(orderBy, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`selectAll(orden ${orderBy}, página ${page}): ${error.message}`);
    const rows = data ?? [];
    out.push(...rows);
    // Página corta (incluida la vacía) = no hay más. Una página exactamente llena
    // obliga a pedir la siguiente, que vuelve vacía y cierra el bucle.
    if (rows.length < pageSize) return out;
  }
}

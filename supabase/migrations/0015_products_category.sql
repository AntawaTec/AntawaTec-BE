-- =============================================================================
-- 0015_products_category.sql
-- Categoría de inventario (products.category). Texto libre en V1: el FE agrupa por
-- esta columna y cae a `brand` si está vacía. SIN tabla product_categories — una
-- taxonomía gestionada por taller es normalización que el producto no pidió y que
-- agrega joins + superficie RLS para cero beneficio en V1 (principio "sin tablas
-- del futuro" de CLAUDE.md). Si más adelante se necesitan sets cerrados o
-- propagación de renombres, es una migración aditiva limpia (category_id backfileado
-- desde el texto).
--
-- products ya es shop-scoped (apply_tenant_rls en 0004) => sin cambios de RLS.
-- Índice compuesto (shop_id, category): el patrón de acceso del FE es agrupar por
-- categoría DENTRO de un taller, y RLS fuerza el predicado shop_id en toda query.
-- Costo trivial en un catálogo por-taller; coincide con el índice shop_id universal
-- del repo.
-- =============================================================================

alter table public.products add column category text;

create index products_category_idx on public.products (shop_id, category);

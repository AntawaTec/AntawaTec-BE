-- 0031_catalog_prod_feedback.sql
-- Ajustes del catálogo maestro (catalog_items) pedidos en feedback de PROD (2026-07-22).
-- El catálogo es un árbol GLOBAL de solo-lectura sembrado en 0025/0026 (el FE nunca lo
-- escribe). Esas migraciones YA están aplicadas en prod, así que los ajustes van como una
-- migración nueva con UPDATEs idempotentes por id.
--
--   Ítem 2 — "Poner mayúsculas en las primeras palabras y 'Cambio' en vez de traslado":
--     capitaliza la primera letra de los ítems que quedaron en minúscula (transcripción
--     literal de Zoho, ver cabecera de 0025) y renombra "Traslado aceite 4x4" → "Cambio
--     aceite 4x4". Solo se capitaliza la PRIMERA letra (lo pedido); la tilde faltante de
--     "Brazos direccion" es una normalización aparte y no se toca.
--   Ítem 1 — "Faltan Faros después de guardachoque": el nodo raíz "Faros" ya existía en el
--     módulo enderezada_pintura pero con sort_order 22 (aparecía al final). Se mueve a la
--     posición 2, justo después de "Guardachoque Delantero" (sort_order 1), desplazando +1
--     el resto de los raíces. sort_order no tiene índice único (el único índice único es
--     (module, parent_id, name)), así que los duplicados transitorios no rompen nada.

-- ── Ítem 2: nombres (por id, preciso e idempotente) ──────────────────────────────────────
update catalog_items set name = 'Aceites diferenciales' where id = 'c1000000-0000-4000-8000-000000000003';
update catalog_items set name = 'Cambio aceite 4x4'     where id = 'c1000000-0000-4000-8000-000000000004';
update catalog_items set name = 'Batería'               where id = 'c1000000-0000-4000-8000-000000000011';
update catalog_items set name = 'Frenos ABC'            where id = 'c2000000-0000-4000-8000-000000000007';
update catalog_items set name = 'Brazos direccion'      where id = 'c2000000-0000-4000-8000-000000000016';

-- ── Ítem 1: mover "Faros" a justo después de "Guardachoque Delantero" ─────────────────────
-- 1) correr +1 los raíces del módulo con sort_order 2..21 (2→3, …, 21→22)
update catalog_items
  set sort_order = sort_order + 1
  where module = 'enderezada_pintura' and parent_id is null and sort_order between 2 and 21;
-- 2) "Faros" (id …148, estaba en 22) pasa a la posición 2
update catalog_items
  set sort_order = 2
  where id = 'c3000000-0000-4000-8000-000000000148';

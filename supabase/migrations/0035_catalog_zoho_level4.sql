-- 0035_catalog_zoho_level4.sql
-- Cierra la brecha de profundidad del catálogo maestro para la migración de Zoho.
-- Decisiones #19 y #20 de docs/zoho-mapping.md (§10) del repo hermano AntawaTec-FE.
--
-- CONTEXTO. El árbol de `reparacion` de Zoho Creator tiene un nivel más que el catálogo
-- sembrado en 0026: los talleres marcan "Alternador → Diodos", "Motor de arranque →
-- Bendix", "Mesas de suspensión → Superiores"… y esas hojas no tenían destino, así que
-- el import las perdería. Se siembran los 36 nodos faltantes de `reparacion` (más 3 de
-- `enderezada_pintura`, abajo) para poder importar con fidelidad.
--
-- FUENTE DE VERDAD. Meta de la API de Zoho Creator v2.1 (`/meta/{owner}/antawamulti/form/
-- Reparaciones_Service_Log/fields`, leída el 2026-08-25): cada campo t15 es un nodo padre
-- y sus `choices` son sus hijos. La app multi es el SUPERCONJUNTO — DC y Greenwash no
-- tienen las ramas `Reparación Electrónica` ni `Escape`, su data es un subconjunto.
-- Cruce contra los 256 catalog_items de prod: los 104 nodos de mantenimiento+reparacion
-- quedan cubiertos y estos 36 son los únicos sin destino.
--
-- MODELADO. Todos `boolean`, como el resto del árbol de `reparacion` (convención del
-- header de 0025/0026). UUIDs deterministas correlativos: c2…086 … c2…121 (0026 llegó a
-- …085), para que el tooling de import mapee picklist→catalog_item_id igual en local,
-- staging y prod. `sort_order` sigue el orden de las opciones en Zoho.
--
-- ⚠️ Tres nombres se repiten en otra rama a propósito (`ABS`, `Bujes`, `Rodamientos`):
-- son componentes distintos con el mismo nombre y el unique de hermanos es
-- (module, parent_id, name), así que conviven. Por eso la tabla de traducción del
-- importador mapea por RAMA COMPLETA, nunca por nombre suelto.

insert into public.catalog_items (id, module, parent_id, name, selection_type, enum_options, sort_order) values
  ('c2000000-0000-4000-8000-000000000086', 'reparacion', 'c2000000-0000-4000-8000-000000000024', 'Primaria', 'boolean', null, 1),  -- Rep. Embrague › Bomba › Primaria
  ('c2000000-0000-4000-8000-000000000087', 'reparacion', 'c2000000-0000-4000-8000-000000000024', 'Secundaria', 'boolean', null, 2),  -- Rep. Embrague › Bomba › Secundaria
  ('c2000000-0000-4000-8000-000000000088', 'reparacion', 'c2000000-0000-4000-8000-000000000016', 'Pitman', 'boolean', null, 1),  -- ABC dirección › Brazos dirección › Pitman
  ('c2000000-0000-4000-8000-000000000089', 'reparacion', 'c2000000-0000-4000-8000-000000000016', 'Auxiliar', 'boolean', null, 2),  -- ABC dirección › Brazos dirección › Auxiliar
  ('c2000000-0000-4000-8000-000000000090', 'reparacion', 'c2000000-0000-4000-8000-000000000016', 'Barra central', 'boolean', null, 3),  -- ABC dirección › Brazos dirección › Barra central
  ('c2000000-0000-4000-8000-000000000091', 'reparacion', 'c2000000-0000-4000-8000-000000000011', 'Delanteros', 'boolean', null, 1),  -- ABC frenos › Rectificar discos o tambores › Delanteros
  ('c2000000-0000-4000-8000-000000000092', 'reparacion', 'c2000000-0000-4000-8000-000000000011', 'Posteriores', 'boolean', null, 2),  -- ABC frenos › Rectificar discos o tambores › Posteriores
  ('c2000000-0000-4000-8000-000000000093', 'reparacion', 'c2000000-0000-4000-8000-000000000010', 'Delanteras', 'boolean', null, 1),  -- ABC frenos › Kit de reparación de mordazas › Delanteras
  ('c2000000-0000-4000-8000-000000000094', 'reparacion', 'c2000000-0000-4000-8000-000000000010', 'Posteriores', 'boolean', null, 2),  -- ABC frenos › Kit de reparación de mordazas › Posteriores
  ('c2000000-0000-4000-8000-000000000095', 'reparacion', 'c2000000-0000-4000-8000-000000000004', 'Superiores', 'boolean', null, 1),  -- ABC suspensión › Mesas de suspensión › Superiores
  ('c2000000-0000-4000-8000-000000000096', 'reparacion', 'c2000000-0000-4000-8000-000000000004', 'Inferiores', 'boolean', null, 2),  -- ABC suspensión › Mesas de suspensión › Inferiores
  ('c2000000-0000-4000-8000-000000000097', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'Sensor MAP', 'boolean', null, 1),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › Sensor MAP
  ('c2000000-0000-4000-8000-000000000098', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'Sensor MAF', 'boolean', null, 2),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › Sensor MAF
  ('c2000000-0000-4000-8000-000000000099', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'Sensor CKP', 'boolean', null, 3),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › Sensor CKP
  ('c2000000-0000-4000-8000-000000000100', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'Sensor CMP', 'boolean', null, 4),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › Sensor CMP
  ('c2000000-0000-4000-8000-000000000101', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'Sensor de oxígeno', 'boolean', null, 5),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › Sensor de oxígeno
  ('c2000000-0000-4000-8000-000000000102', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'TPS', 'boolean', null, 6),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › TPS
  ('c2000000-0000-4000-8000-000000000103', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'Temperatura de motor', 'boolean', null, 7),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › Temperatura de motor
  ('c2000000-0000-4000-8000-000000000104', 'reparacion', 'c2000000-0000-4000-8000-000000000072', 'ABS', 'boolean', null, 8),  -- Reparación Electrónica › Diagnóstico electrónico › Sensores y actuadores › ABS
  ('c2000000-0000-4000-8000-000000000105', 'reparacion', 'c2000000-0000-4000-8000-000000000071', 'Revisión de códigos de falla', 'boolean', null, 1),  -- Reparación Electrónica › Diagnóstico electrónico › Escáner automotriz › Revisión de códigos de falla
  ('c2000000-0000-4000-8000-000000000106', 'reparacion', 'c2000000-0000-4000-8000-000000000071', 'Borrado de códigos', 'boolean', null, 2),  -- Reparación Electrónica › Diagnóstico electrónico › Escáner automotriz › Borrado de códigos
  ('c2000000-0000-4000-8000-000000000107', 'reparacion', 'c2000000-0000-4000-8000-000000000071', 'Programación básica', 'boolean', null, 3),  -- Reparación Electrónica › Diagnóstico electrónico › Escáner automotriz › Programación básica
  ('c2000000-0000-4000-8000-000000000108', 'reparacion', 'c2000000-0000-4000-8000-000000000058', 'Automático', 'boolean', null, 1),  -- Reparación Electrónica › Sistema de arranque › Motor de arranque › Automático
  ('c2000000-0000-4000-8000-000000000109', 'reparacion', 'c2000000-0000-4000-8000-000000000058', 'Bendix', 'boolean', null, 2),  -- Reparación Electrónica › Sistema de arranque › Motor de arranque › Bendix
  ('c2000000-0000-4000-8000-000000000110', 'reparacion', 'c2000000-0000-4000-8000-000000000058', 'Carbones', 'boolean', null, 3),  -- Reparación Electrónica › Sistema de arranque › Motor de arranque › Carbones
  ('c2000000-0000-4000-8000-000000000111', 'reparacion', 'c2000000-0000-4000-8000-000000000058', 'Inducido', 'boolean', null, 4),  -- Reparación Electrónica › Sistema de arranque › Motor de arranque › Inducido
  ('c2000000-0000-4000-8000-000000000112', 'reparacion', 'c2000000-0000-4000-8000-000000000058', 'Bujes', 'boolean', null, 5),  -- Reparación Electrónica › Sistema de arranque › Motor de arranque › Bujes
  ('c2000000-0000-4000-8000-000000000113', 'reparacion', 'c2000000-0000-4000-8000-000000000056', 'Prueba de carga', 'boolean', null, 1),  -- Reparación Electrónica › Sistema de carga › Batería › Prueba de carga
  ('c2000000-0000-4000-8000-000000000114', 'reparacion', 'c2000000-0000-4000-8000-000000000056', 'Bornes', 'boolean', null, 2),  -- Reparación Electrónica › Sistema de carga › Batería › Bornes
  ('c2000000-0000-4000-8000-000000000115', 'reparacion', 'c2000000-0000-4000-8000-000000000056', 'Consumo parásito', 'boolean', null, 3),  -- Reparación Electrónica › Sistema de carga › Batería › Consumo parásito
  ('c2000000-0000-4000-8000-000000000116', 'reparacion', 'c2000000-0000-4000-8000-000000000055', 'Regulador de corriente', 'boolean', null, 1),  -- Reparación Electrónica › Sistema de carga › Alternador › Regulador de corriente
  ('c2000000-0000-4000-8000-000000000117', 'reparacion', 'c2000000-0000-4000-8000-000000000055', 'Carbones', 'boolean', null, 2),  -- Reparación Electrónica › Sistema de carga › Alternador › Carbones
  ('c2000000-0000-4000-8000-000000000118', 'reparacion', 'c2000000-0000-4000-8000-000000000055', 'Diodos', 'boolean', null, 3),  -- Reparación Electrónica › Sistema de carga › Alternador › Diodos
  ('c2000000-0000-4000-8000-000000000119', 'reparacion', 'c2000000-0000-4000-8000-000000000055', 'Placa rectificadora', 'boolean', null, 4),  -- Reparación Electrónica › Sistema de carga › Alternador › Placa rectificadora
  ('c2000000-0000-4000-8000-000000000120', 'reparacion', 'c2000000-0000-4000-8000-000000000055', 'Polea', 'boolean', null, 5),  -- Reparación Electrónica › Sistema de carga › Alternador › Polea
  ('c2000000-0000-4000-8000-000000000121', 'reparacion', 'c2000000-0000-4000-8000-000000000055', 'Rodamientos', 'boolean', null, 6)   -- Reparación Electrónica › Sistema de carga › Alternador › Rodamientos
on conflict (id) do nothing;

-- ── Tres sub-componentes de "Capota" que 0026 omitió ──────────────────────────────────
-- Detectados al construir la tabla de traducción (scripts/zoho/build-catalog-map.mjs del
-- FE): los campos `Soporte_LH_Capote`, `Soporte_de_faro_FDR` y `Soporte_de_faro_FDL`
-- existen en las TRES apps de Zoho (multi, Greenwash y DC) y no tenían destino — el
-- importador los perdería. Es la misma omisión que 0026 ya corrigió al espejar los
-- sub-componentes de "Puerta Delantera LH" desde RH.
--
-- Los dos "Soporte de faro" comparten etiqueta en Zoho (uno de ellos con espacio duro
-- `&#xa0;` al final): se desambiguan como RH/LH porque el unique de hermanos es por
-- nombre. La tabla de traducción mapea por LINK NAME, así que el nombre visible es libre.
insert into public.catalog_items (id, module, parent_id, name, selection_type, enum_options, sort_order) values
  ('c3000000-0000-4000-8000-000000000153', 'enderezada_pintura', 'c3000000-0000-4000-8000-000000000012', 'Soporte LH Capote', 'enum_select', array['RR','REP','Pintura'], 8),
  ('c3000000-0000-4000-8000-000000000154', 'enderezada_pintura', 'c3000000-0000-4000-8000-000000000012', 'Soporte de faro RH', 'enum_select', array['RR','REP','Pintura'], 9),
  ('c3000000-0000-4000-8000-000000000155', 'enderezada_pintura', 'c3000000-0000-4000-8000-000000000012', 'Soporte de faro LH', 'enum_select', array['RR','REP','Pintura'], 10)
on conflict (id) do nothing;

-- ── Decisión #20: "Directrices" era un error de traducción ────────────────────────────
-- En Zoho la opción es "Direccionales" (las luces de giro, rama Luces y accesorios).
-- "Directrices" no significa nada en este contexto. Idempotente por id, como 0031.
update public.catalog_items
  set name = 'Direccionales'
  where id = 'c2000000-0000-4000-8000-000000000063';

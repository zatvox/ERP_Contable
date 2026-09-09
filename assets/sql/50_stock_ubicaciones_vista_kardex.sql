-- ============================================================================
-- ✅ APLICADO EN PRODUCCIÓN (29/08/2026)
-- Historia real (para que quede constancia, no fue un solo intento limpio):
--   1er intento: se aplicó la vista y la verificación mostró 41 lotes con
--     cantidad_en_zonas = 0 aun teniendo stock. Se revirtió de inmediato.
--     Diagnóstico inicial (INCORRECTO): "esos lotes nunca generaron
--     kardex, deben ser carga inicial por SQL directo". Luis lo cuestionó
--     con evidencia (captura de Kardex Valorizado de HR-Q083072T0 mostrando
--     entradas reales) y tenía razón — la causa real era otra.
--   Causa real encontrada: inventario.js grababa los traslados internos con
--     cantidad_entrada = 0 (hardcodeado) en la fila de kardex, dejando solo
--     cantidad_salida en el origen. Para el saldo del LOTE (saldo_cantidad)
--     eso no importa porque un traslado no cambia el total del lote — pero
--     para cualquier cálculo POR ZONA (esta vista, y el reporte "Kardex
--     resumido" en Reportes) cada traslado se contaba como una fuga real de
--     inventario, nunca repuesta del otro lado.
--   Fix de raíz: inventario.js ahora graba cantidad_entrada = cantidad_salida
--     (mismo monto) en la fila de traslado_interno — ver
--     window.guardarTrasladoInterno y window.procesarImportacionTraslados.
--     Se hizo backfill de los 173 traslados históricos con el mismo criterio.
--   Resultado: de 77 filas desincronizadas (diagnóstico original) se pasó a
--     11 lotes con diferencia residual — todos por lotes.cantidad
--     desactualizado (bug aparte, no de esta vista), no por la vista en sí.
--     Ejemplo: HR-Q083072T0 tiene lotes.cantidad=23,112 pero Kardex
--     (entradas=48,960, ventas=48,960) dice que está 100% vendido — Luis lo
--     confirmó también contra Odoo. Pendiente investigar aparte.
--   JWXY2601 verificado en vivo: Zona A=11,525 / Zona B=3,725 kg — coincide
--     EXACTO con la reconciliación manual hecha al inicio de esta
--     investigación contra el Kardex exportado por Luis.
-- ============================================================================

-- ============================================================================
-- 50_stock_ubicaciones_vista_kardex.sql
-- Convierte stock_ubicaciones de TABLA escrita a mano (por Compras, Ventas
-- e Inventario, en 3 archivos JS distintos) a VISTA calculada en vivo desde
-- el Kardex — que ya es la fuente de verdad probada (cuadra con lotes.cantidad
-- y con reportes externos). Elimina de raíz la clase de bug de sincronización:
-- ya no hay ningún INSERT/UPDATE/DELETE manual que se pueda "olvidar" o fallar
-- a medias. Mismo patrón que ya usa v_stock_bultos_zona (43_lote_bultos.sql).
--
-- Diagnóstico previo (lote JWXY2601 y verificación global):
--   - Kardex 100% poblado: los 742 movimientos vigentes (280 entrada, 289
--     salida, 173 traslado_interno) tienen ubicacion_origen_id Y
--     ubicacion_destino_id (0 nulos) — no hay huecos históricos.
--   - El desbalance NO es exclusivo de un lote: 77 de 188 filas de
--     stock_ubicaciones (41%) no cuadran contra lo que dice el Kardex.
--   - stock_ubicaciones no tiene ninguna FK entrante (ninguna otra tabla
--     referencia stock_ubicaciones.id) — migración segura sin romper
--     integridad referencial.
--
-- Modelo (heredado de 21_kardex_origen_destino_partners.sql, estilo Odoo):
--   Compra  -> origen = Partners/Vendors (virtual), destino = zona real.
--   Venta   -> origen = zona real,                  destino = Partners/Customers (virtual).
--   Traslado interno -> origen = zona real,          destino = zona real.
-- Por eso: cantidad que ENTRA a una zona real = cantidad_entrada de las filas
-- donde esa zona es destino; cantidad que SALE = cantidad_salida de las filas
-- donde esa zona es origen. Sumando ambos por lote+zona y excluyendo los
-- almacenes virtuales, se reconstruye el stock exacto sin tocar una tabla
-- aparte.
-- ============================================================================

-- 0) Backfill: los traslado_interno grabados ANTES del fix en inventario.js
--    (guardarTrasladoInterno / procesarImportacionTraslados) tenían
--    cantidad_entrada = 0. Se igualan a cantidad_salida para que representen
--    correctamente "la misma cantidad entra a destino y sale de origen".
--    Ya ejecutado en producción (173 filas); se deja aquí para que el
--    script sea reproducible en otro ambiente.
UPDATE public.kardex
SET cantidad_entrada = cantidad_salida,
    cantidad_unidades_entrada = cantidad_unidades_salida
WHERE tipo_movimiento = 'traslado_interno'
  AND cantidad_entrada = 0
  AND cantidad_salida > 0;

-- 1) Vista de cálculo (nombre temporal, se renombra al final del script para
--    que el swap sea atómico dentro de la misma sesión).
CREATE OR REPLACE VIEW public.v_stock_ubicaciones_kardex AS
WITH mov AS (
  SELECT lote_id,
         ubicacion_destino_id AS ubicacion_id,
         cantidad_entrada     AS cant,
         cantidad_unidades_entrada AS uni
  FROM public.kardex
  WHERE ubicacion_destino_id IS NOT NULL

  UNION ALL

  SELECT lote_id,
         ubicacion_origen_id  AS ubicacion_id,
         -cantidad_salida     AS cant,
         -cantidad_unidades_salida AS uni
  FROM public.kardex
  WHERE ubicacion_origen_id IS NOT NULL
),
calc AS (
  SELECT
    mov.lote_id,
    mov.ubicacion_id,
    SUM(mov.cant) AS cantidad,
    SUM(mov.uni)  AS cantidad_unidades
  FROM mov
  JOIN public.ubicaciones u ON u.id = mov.ubicacion_id
  JOIN public.almacenes   a ON a.id = u.almacen_id
  WHERE a.es_virtual = false   -- descarta Partners/Vendors y Partners/Customers
  GROUP BY mov.lote_id, mov.ubicacion_id
  HAVING ROUND(SUM(mov.cant)::numeric, 4) > 0   -- igual que el código viejo: fila desaparece al llegar a 0
)
SELECT
  row_number() OVER (ORDER BY lote_id, ubicacion_id)::bigint AS id,
  lote_id,
  ubicacion_id,
  ROUND(cantidad::numeric, 4)          AS cantidad,
  ROUND(cantidad_unidades::numeric, 4) AS cantidad_unidades,
  now() AS created_at,
  now() AS updated_at
FROM calc;

COMMENT ON VIEW public.v_stock_ubicaciones_kardex IS
  'Cálculo en vivo de stock por lote+zona desde kardex. Ver 50_stock_ubicaciones_vista_kardex.sql.';

-- 2) Swap atómico: la tabla vieja se conserva completa como respaldo (no se
--    borra ningún dato, por regla del proyecto), y el nombre público
--    "stock_ubicaciones" pasa a apuntar a la vista.
ALTER TABLE public.stock_ubicaciones RENAME TO stock_ubicaciones_legacy;
COMMENT ON TABLE public.stock_ubicaciones_legacy IS
  'DEPRECADA — respaldo de la tabla escrita a mano antes de 50_stock_ubicaciones_vista_kardex.sql. No la usa ningún código desde esa migración. No borrar sin confirmar con Luis.';

ALTER VIEW public.v_stock_ubicaciones_kardex RENAME TO stock_ubicaciones;

-- 3) Grants: solo lectura (ya no hay escritura manual posible ni necesaria).
GRANT SELECT ON public.stock_ubicaciones TO authenticated;

-- 4) Verificación: la vista debe devolver el mismo total de kg por lote que
--    lotes.cantidad (chequeo de cuadre global, no debería haber diferencias
--    fuera de redondeo).
SELECT l.id, l.numero_lote, l.cantidad AS cantidad_lote,
       COALESCE(SUM(s.cantidad), 0) AS cantidad_en_zonas,
       l.cantidad - COALESCE(SUM(s.cantidad), 0) AS diferencia
FROM public.lotes l
LEFT JOIN public.stock_ubicaciones s ON s.lote_id = l.id
GROUP BY l.id, l.numero_lote, l.cantidad
HAVING ABS(l.cantidad - COALESCE(SUM(s.cantidad), 0)) > 0.01
ORDER BY 1;

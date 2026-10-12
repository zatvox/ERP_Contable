-- 84 — Kardex huérfano de la guía GN01-00000007 (venta NV01-9, Elvira Meza)
-- La guía original (lote MB31516) se borró pero su fila de Kardex #1437 quedó.
-- Efecto: mostraba 1,008 kg de MB31516 trasladados de Zona A → Zona B que nunca
-- se movieron, y el N° GN01-07 aparecía con el cliente equivocado.
-- La guía vigente de esa venta es GN01-00000009 (lote MB31539) — se conserva.
DO $$
BEGIN
  CREATE TABLE IF NOT EXISTS _bk84_kardex AS SELECT * FROM kardex WHERE false;
  INSERT INTO _bk84_kardex SELECT * FROM kardex WHERE id = 1437;

  DELETE FROM kardex k
   WHERE k.id = 1437
     AND k.venta_id = 528
     AND k.documento_referencia = 'GN01-00000007'
     AND NOT EXISTS (SELECT 1 FROM guias_despacho_venta g
                      WHERE g.venta_id = k.venta_id AND g.numero_guia = k.documento_referencia);
END $$;

-- Verificación: debe dar 0 filas
SELECT k.id, k.venta_id, k.documento_referencia
  FROM kardex k
 WHERE k.venta_id IS NOT NULL AND k.tipo_movimiento = 'salida'
   AND k.concepto ILIKE '%guía%'
   AND NOT EXISTS (SELECT 1 FROM guias_despacho_venta g
                    WHERE g.venta_id = k.venta_id AND g.numero_guia = k.documento_referencia);

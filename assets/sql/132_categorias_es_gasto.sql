-- 131: Apertura de caja y Vales NO son gasto. Se marcan por categoría.
ALTER TABLE categorias_gasto ADD COLUMN IF NOT EXISTS es_gasto boolean NOT NULL DEFAULT true;

INSERT INTO categorias_gasto (codigo, nombre, ambito_sugerido, destino_sugerido, deducible_defecto, orden, activo, color, es_gasto)
SELECT 'APERTURA', 'Apertura / arrastre de saldo', 'empresa', 'no_deducible', false, 900, true, '#64748b', false
WHERE NOT EXISTS (SELECT 1 FROM categorias_gasto WHERE codigo = 'APERTURA');

UPDATE categorias_gasto SET es_gasto = false
 WHERE nombre ILIKE 'Vales y adelantos%' OR codigo = 'APERTURA';

-- La fila APERTURA ya cargada pasa a su categoría
UPDATE gastos SET categoria_gasto_id = (SELECT id FROM categorias_gasto WHERE codigo='APERTURA'),
                  destino_costo = 'no_deducible'
 WHERE detalle ILIKE 'SALDO DE APERTURA%';

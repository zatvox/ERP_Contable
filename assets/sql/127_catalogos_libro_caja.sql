-- ============================================================================
-- 127 · CATÁLOGOS del Libro de caja — solo campos predefinidos, SIN datos
-- 2026-11-01 · Requiere los SQL 123, 124 y 125.
-- ----------------------------------------------------------------------------
-- Crea únicamente las OPCIONES que faltaban para poder registrar el Excel de
-- octubre desde la pantalla: tipos de documento, la categoría ANN y las
-- personas de la columna Responsable.
--
-- Los movimientos NO se cargan por SQL: se registran desde el Libro de caja,
-- que es lo que hay que probar.
--
-- ⚠ Sin TEMP TABLES a propósito: el editor SQL de Supabase no las conserva
--   entre sentencias (fue lo que hizo fallar el intento anterior).
-- IDEMPOTENTE: se puede correr varias veces sin duplicar.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 · Tipos de documento que usa la tesorera y no existían
-- ════════════════════════════════════════════════════════════════════════════
-- «Reembolso» y «Planilla» son etiquetas suyas. El sustento_base las ancla al
-- tratamiento tributario real: ninguna de las dos sustenta gasto deducible.
INSERT INTO public.tipos_documento_gasto (codigo, nombre, sustento_base, color, orden) VALUES
  ('REEMBOLSO', 'Reembolso', 'sin_documento', '#15803d', 35),
  ('PLANILLA',  'Planilla',  'sin_documento', '#a21caf', 45)
ON CONFLICT (codigo) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 · Categoría ANN (gastos de la hija del dueño)
-- ════════════════════════════════════════════════════════════════════════════
-- En el Excel «ANN» estaba a la vez en Categoría y en Responsable. Aquí se
-- separa: la categoría es DE QUÉ fue el gasto, el responsable es QUIÉN.
INSERT INTO public.categorias_gasto
  (codigo, nombre, ambito_sugerido, destino_sugerido, deducible_defecto, color, orden)
VALUES
  ('ANN', 'ANN (gastos de la hija)', 'familiar', 'no_deducible', false, '#eab308', 205)
ON CONFLICT (codigo) DO NOTHING;

-- MERCADO también es familiar: en el Excel son el pollo, las verduras y la
-- compra del Metro. Se ajusta su sugerencia para que la grilla la precargue.
UPDATE public.categorias_gasto
   SET ambito_sugerido = 'familiar'
 WHERE codigo = 'MERCADO' AND ambito_sugerido IS NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 · Personas de la columna «Responsable»
-- ════════════════════════════════════════════════════════════════════════════
-- Van con tipo_documento 'NN' porque el Excel no trae DNI. Complétalos
-- después desde Contactos; el ERP ya valida RUC/DNI contra Decolecta.
--
-- Nota: «OFICINA» NO se crea como contacto. No es una persona: significa
-- "sin responsable", y en la grilla se deja esa celda vacía.
DO $$
DECLARE
  v_arr boolean;
  v_nombre text;
  v_personas text[] := ARRAY[
    'SR RAUL', 'CRISTIAN', 'ROSARIO', 'NELI', 'LUIS PAZ', 'SÑRA MARIA', 'ANN'
  ];
  v_doc text;
BEGIN
  SELECT data_type = 'ARRAY' INTO v_arr
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'contacts' AND column_name = 'tipo_contacto';

  FOREACH v_nombre IN ARRAY v_personas LOOP
    IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper(v_nombre)) THEN
      RAISE NOTICE 'Ya existe el contacto %', v_nombre;
      CONTINUE;
    END IF;

    v_doc := 'NN-' || regexp_replace(upper(translate(v_nombre,
               'ÁÉÍÓÚÜÑ', 'AEIOUUN')), '[^A-Z0-9]', '', 'g');

    IF v_arr THEN
      INSERT INTO public.contacts
        (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
      VALUES (v_nombre, 'NN', v_doc, ARRAY['empleado']::text[], '', '', '0');
    ELSE
      INSERT INTO public.contacts
        (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
      VALUES (v_nombre, 'NN', v_doc, 'empleado', '', '', '0');
    END IF;
    RAISE NOTICE 'Contacto creado: % (%)', v_nombre, v_doc;
  END LOOP;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 · Fondo fijo de la caja de efectivo
-- ════════════════════════════════════════════════════════════════════════════
-- Sin fondo fijo no hay reposición ni alerta de saldo bajo: la caja puede
-- irse a negativo sin que nadie se entere, que es justo lo que pasa en el
-- Excel (llega a −S/ 494.77). Ajusta los montos si usan otros.
UPDATE public.bancos
   SET es_fondo_fijo = true,
       monto_fondo_fijo = 4000,
       saldo_minimo = 800,
       prefijo_recibo = 'REC'
 WHERE id = 6 AND es_fondo_fijo = false;

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. TIPOS DE DOCUMENTO' AS bloque, codigo, nombre, sustento_base, color
  FROM public.tipos_documento_gasto WHERE activo ORDER BY orden;

SELECT '2. CATEGORÍAS' AS bloque, codigo, nombre, ambito_sugerido, destino_sugerido, color
  FROM public.categorias_gasto WHERE activo ORDER BY orden;

SELECT '3. RESPONSABLES' AS bloque, id, nombre, tipo_documento, nro_documento
  FROM public.contacts
 WHERE upper(nombre) IN ('SR RAUL','CRISTIAN','ROSARIO','NELI','LUIS PAZ','SÑRA MARIA','ANN')
 ORDER BY nombre;

SELECT '4. CAJA' AS bloque, id, nombre, moneda, saldo_actual,
       es_fondo_fijo, monto_fondo_fijo, saldo_minimo, prefijo_recibo
  FROM public.bancos WHERE id = 6;

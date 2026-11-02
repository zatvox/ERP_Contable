-- ============================================================================
-- 126 · CARGA — Libro de caja de OCTUBRE 2026 (Excel de la tesorera)
-- 2026-11-01 · Requiere los SQL 123, 124 y 125.
-- ----------------------------------------------------------------------------
-- Carga las 40 filas del Excel en CAJA EFECTIVO SOLES y deja el saldo
-- cuadrando al centavo con la hoja.
--
-- DECISIONES DE MAPEO (revisar antes de correr):
--
--  1. CAJA: «CAJA EFECTIVO SOLES» (id 6, JHIRO, PEN). Cámbiala en la PARTE 0.
--
--  2. SALDO DE APERTURA −160.87: el Excel no arranca en cero. La primera fila
--     (REC-095) entra 3,600.00 y deja 3,439.13, así que venía de −160.87.
--     Se registra como un movimiento explícito del 22/10 en vez de tocar
--     saldo_actual a mano: un saldo negativo de arranque tiene que VERSE.
--     Si no lo quieres, comenta la PARTE 4.
--
--  3. FILAS CON INGRESO *Y* EGRESO (REC-097, 098, 122, 123, 124) → se parten
--     en DOS movimientos. Es el neteo que distorsiona el saldo en el Excel:
--     REC-122 tiene 100 de ingreso y 100 de egreso y "no mueve el saldo",
--     pero son dos hechos distintos (entró plata del cliente, salió plata al
--     cargador). El egreso lleva el N° de recibo como gasto; el ingreso queda
--     como movimiento de caja con ese N° en `referencia`. No chocan con el
--     índice único porque el ingreso no crea fila en `gastos`.
--
--  4. RESPONSABLE «OFICINA» → NULL. No es una persona, es "sin responsable".
--     En el Excel la columna Responsable y la columna Categoría eran el mismo
--     dato; aquí se separan.
--
--  5. «ANN» NO existía como categoría → se crea como FAMILIAR (disfraz,
--     vitaminas, vestido, buzo: gastos de la hija).
--
--  6. ÁMBITO FAMILIAR: las categorías ANN y MERCADO. El resto es JHIRO.
--     ⚠ Por eso, para ver el libro COMPLETO de esta caja hay que tener
--     JHIRO *y* FAMILIAR marcados en el switch de la cabecera.
--
--  7. TIPOS DE DOCUMENTO nuevos: «Reembolso» y «Planilla».
--     «Factura Pendiente» (REC-134) → FACTURA con estado_sustento='pendiente'
--     → estrena la bandeja "Pendientes de factura".
--
--  8. DEDUCIBLE: todo entra en false. Ninguna de estas filas tiene el
--     comprobante cargado todavía, y sin comprobante no hay deducción
--     (LIR art. 44 inc. j). Se marcan desde la UI al adjuntar la factura.
--
-- RE-EJECUTABLE: borra su propia carga antes de volver a insertar.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 0 · Parámetros
-- ════════════════════════════════════════════════════════════════════════════
CREATE TEMP TABLE _cfg ON COMMIT DROP AS
SELECT 6::integer AS caja_id, 1::integer AS empresa_id, '2026-10-22'::date AS fecha_apertura;

DO $$
DECLARE v_caja int; v_nom text;
BEGIN
  SELECT caja_id INTO v_caja FROM _cfg;
  SELECT nombre INTO v_nom FROM public.bancos WHERE id = v_caja;
  IF v_nom IS NULL THEN RAISE EXCEPTION 'No existe la caja %. Edita la PARTE 0.', v_caja; END IF;
  RAISE NOTICE 'Cargando en la caja: % (id %)', v_nom, v_caja;
END $$;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 · Catálogos que faltaban
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO public.tipos_documento_gasto (codigo, nombre, sustento_base, color, orden) VALUES
  ('REEMBOLSO', 'Reembolso', 'sin_documento', '#15803d', 35),
  ('PLANILLA',  'Planilla',  'sin_documento', '#a21caf', 45)
ON CONFLICT (codigo) DO NOTHING;

INSERT INTO public.categorias_gasto (codigo, nombre, ambito_sugerido, destino_sugerido, deducible_defecto, color, orden) VALUES
  ('ANN', 'ANN (gastos de la hija)', 'familiar', 'no_deducible', false, '#eab308', 205)
ON CONFLICT (codigo) DO NOTHING;

-- Personas de la columna Responsable. Van con tipo_documento 'NN' porque el
-- Excel no trae DNI: complétalos después desde Contactos.

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('SR RAUL')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('SR RAUL', 'NN', 'NN-SRRAUL', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('SR RAUL', 'NN', 'NN-SRRAUL', 'empleado', '', '', '0');
  END IF;
END $$;

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('CRISTIAN')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('CRISTIAN', 'NN', 'NN-CRISTIAN', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('CRISTIAN', 'NN', 'NN-CRISTIAN', 'empleado', '', '', '0');
  END IF;
END $$;

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('ROSARIO')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('ROSARIO', 'NN', 'NN-ROSARIO', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('ROSARIO', 'NN', 'NN-ROSARIO', 'empleado', '', '', '0');
  END IF;
END $$;

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('NELI')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('NELI', 'NN', 'NN-NELI', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('NELI', 'NN', 'NN-NELI', 'empleado', '', '', '0');
  END IF;
END $$;

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('LUIS PAZ')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('LUIS PAZ', 'NN', 'NN-LUISPAZ', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('LUIS PAZ', 'NN', 'NN-LUISPAZ', 'empleado', '', '', '0');
  END IF;
END $$;

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('SÑRA MARIA')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('SÑRA MARIA', 'NN', 'NN-SNRAMARIA', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('SÑRA MARIA', 'NN', 'NN-SNRAMARIA', 'empleado', '', '', '0');
  END IF;
END $$;

DO $$
DECLARE v_arr boolean;
BEGIN
  IF EXISTS (SELECT 1 FROM public.contacts WHERE upper(nombre) = upper('ANN')) THEN RETURN; END IF;
  SELECT data_type = 'ARRAY' INTO v_arr FROM information_schema.columns
    WHERE table_schema='public' AND table_name='contacts' AND column_name='tipo_contacto';
  IF v_arr THEN
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('ANN', 'NN', 'NN-ANN', ARRAY['empleado']::text[], '', '', '0');
  ELSE
    INSERT INTO public.contacts (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito, numero)
    VALUES ('ANN', 'NN', 'NN-ANN', 'empleado', '', '', '0');
  END IF;
END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 · Limpieza de una carga anterior (hace el script re-ejecutable)
-- ════════════════════════════════════════════════════════════════════════════
DELETE FROM public.movimientos_banco m
 USING public.gastos g, _cfg
 WHERE g.movimiento_id = m.id AND g.caja_id = _cfg.caja_id
   AND g.numero_recibo IN ('REC-095', 'REC-096', 'REC-097', 'REC-098', 'REC-099', 'REC-100', 'REC-101', 'REC-102', 'REC-103', 'REC-104', 'REC-105', 'REC-106', 'REC-107', 'REC-108', 'REC-109', 'REC-110', 'REC-111', 'REC-112', 'REC-113', 'REC-115', 'REC-116', 'REC-119', 'REC-120', 'REC-121', 'REC-122', 'REC-123', 'REC-124', 'REC-125', 'REC-126', 'REC-127', 'REC-128', 'REC-129', 'REC-130', 'REC-131', 'REC-132', 'REC-133', 'REC-134', 'REC-135', 'REC-136', 'REC-41');
DELETE FROM public.gastos g USING _cfg
 WHERE g.caja_id = _cfg.caja_id AND g.numero_recibo IN ('REC-095', 'REC-096', 'REC-097', 'REC-098', 'REC-099', 'REC-100', 'REC-101', 'REC-102', 'REC-103', 'REC-104', 'REC-105', 'REC-106', 'REC-107', 'REC-108', 'REC-109', 'REC-110', 'REC-111', 'REC-112', 'REC-113', 'REC-115', 'REC-116', 'REC-119', 'REC-120', 'REC-121', 'REC-122', 'REC-123', 'REC-124', 'REC-125', 'REC-126', 'REC-127', 'REC-128', 'REC-129', 'REC-130', 'REC-131', 'REC-132', 'REC-133', 'REC-134', 'REC-135', 'REC-136', 'REC-41');
DELETE FROM public.movimientos_banco m USING _cfg
 WHERE m.banco_id = _cfg.caja_id
   AND (m.referencia IN ('REC-095', 'REC-096', 'REC-097', 'REC-098', 'REC-099', 'REC-100', 'REC-101', 'REC-102', 'REC-103', 'REC-104', 'REC-105', 'REC-106', 'REC-107', 'REC-108', 'REC-109', 'REC-110', 'REC-111', 'REC-112', 'REC-113', 'REC-115', 'REC-116', 'REC-119', 'REC-120', 'REC-121', 'REC-122', 'REC-123', 'REC-124', 'REC-125', 'REC-126', 'REC-127', 'REC-128', 'REC-129', 'REC-130', 'REC-131', 'REC-132', 'REC-133', 'REC-134', 'REC-135', 'REC-136', 'REC-41') OR m.concepto LIKE 'Saldo de apertura%%');

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 · Saldo de apertura (ver nota 2 de la cabecera)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO public.movimientos_banco (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, referencia)
SELECT caja_id, fecha_apertura, 'egreso',
       'Saldo de apertura (arrastre del Excel al 22/10/2026)', 160.87, 'empresa', empresa_id, 'APERTURA'
  FROM _cfg;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 · Las 40 filas
-- ════════════════════════════════════════════════════════════════════════════

-- REC-095 · REEMBOLSO SR RAUL EFECTIVO
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-23', 'ingreso', 'REEMBOLSO SR RAUL EFECTIVO', 3600.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='REEMBOLSO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SR RAUL') LIMIT 1), 'REC-095' FROM _cfg;

-- REC-096 · F001- 40647 / COMBUSTIBLE - VENTA DANIEL ZEVALLOS-JUAN MEZA- R
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'F001- 40647 / COMBUSTIBLE - VENTA DANIEL ZEVALLOS-JUAN MEZA- REYNALDO', 28.40, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='COMBUSTIBLE'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('CRISTIAN') LIMIT 1), 'REC-096' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-096', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('CRISTIAN') LIMIT 1), 'F001- 40647 / COMBUSTIBLE - VENTA DANIEL ZEVALLOS-JUAN MEZA- REYNALDO', 'PEN', 28.40,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'COMBUSTIBLE'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-097 · SR RAUL YAPEO 140 A CARGADOR ELIO/ CL DANIEL ZEVALLOS 19 CUERD
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-23', 'ingreso', 'Ingreso · SR RAUL YAPEO 140 A CARGADOR ELIO/ CL DANIEL ZEVALLOS 19 CUERDAS INDIGO', 140.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-097' FROM _cfg;
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'SR RAUL YAPEO 140 A CARGADOR ELIO/ CL DANIEL ZEVALLOS 19 CUERDAS INDIGO', 200.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-097' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-097', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'SR RAUL YAPEO 140 A CARGADOR ELIO/ CL DANIEL ZEVALLOS 19 CUERDAS INDIGO', 'PEN', 200.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'CARGADORES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-098 · SR RAUL YAPEO 140 A CARGADOR CESAR/ CL DANIEL ZEVALLOS 19 CUER
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-23', 'ingreso', 'Ingreso · SR RAUL YAPEO 140 A CARGADOR CESAR/ CL DANIEL ZEVALLOS 19 CUERDAS INDIGO', 140.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-098' FROM _cfg;
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'SR RAUL YAPEO 140 A CARGADOR CESAR/ CL DANIEL ZEVALLOS 19 CUERDAS INDIGO', 200.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-098' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-098', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'SR RAUL YAPEO 140 A CARGADOR CESAR/ CL DANIEL ZEVALLOS 19 CUERDAS INDIGO', 'PEN', 200.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'CARGADORES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-099 · RECARGA SUNARP - SOLICITAR VIGENCIA PODER HTC
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'RECARGA SUNARP - SOLICITAR VIGENCIA PODER HTC', 50.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-099' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-099', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'RECARGA SUNARP - SOLICITAR VIGENCIA PODER HTC', 'PEN', 50.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-100 · DISFRAZ MARINA 45 DANZA - 6 DE ALQUILER YANQQUE
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'DISFRAZ MARINA 45 DANZA - 6 DE ALQUILER YANQQUE', 51.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='ANN'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'REC-100' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-100', '2026-10-23', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'DISFRAZ MARINA 45 DANZA - 6 DE ALQUILER YANQQUE', 'PEN', 51.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'ANN'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-101 · CESAR 52 CAJAS PUENTE PIEDRA + 20 BOLSAS SPUN CL FUNG
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'CESAR 52 CAJAS PUENTE PIEDRA + 20 BOLSAS SPUN CL FUNG', 70.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-101' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-101', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'CESAR 52 CAJAS PUENTE PIEDRA + 20 BOLSAS SPUN CL FUNG', 'PEN', 70.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'CARGADORES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-102 · SOLIDARIDAD - ATENCION A MARINA PAZ b543-191696
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'SOLIDARIDAD - ATENCION A MARINA PAZ b543-191696', 55.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='ANN'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'REC-102' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-102', '2026-10-23', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'SOLIDARIDAD - ATENCION A MARINA PAZ b543-191696', 'PEN', 55.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'ANN'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'BOLETA';

-- REC-103 · ABOGADO FRANCO ADELANTO CASO BANBIF
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'ABOGADO FRANCO ADELANTO CASO BANBIF', 400.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-103' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-103', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'ABOGADO FRANCO ADELANTO CASO BANBIF', 'PEN', 400.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-104 · 68 BOLSAS SPUN DEL 2DO PISO /CL ANGELO PK PK.18700
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', '68 BOLSAS SPUN DEL 2DO PISO /CL ANGELO PK PK.18700', 60.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-104' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-104', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, '68 BOLSAS SPUN DEL 2DO PISO /CL ANGELO PK PK.18700', 'PEN', 60.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'CARGADORES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-105 · ANDREA CONTADOORA
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'ANDREA CONTADOORA', 600.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='VALES'), NULL, 'REC-105' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-105', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'ANDREA CONTADOORA', 'PEN', 600.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'VALES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-106 · MUNICIPALIDAD POLONIA
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'MUNICIPALIDAD POLONIA', 500.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'REC-106' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-106', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'MUNICIPALIDAD POLONIA', 'PEN', 500.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-107 · ITSE - MUNICIPLAIDAD
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'ITSE - MUNICIPLAIDAD', 735.10, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='SUNAT_MUNI'), NULL, 'REC-107' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-107', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'ITSE - MUNICIPLAIDAD', 'PEN', 735.10,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'SUNAT_MUNI'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-108 · PAGAR MUNICIPALIDAD - TRAMITE ITSE-PASAJE
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'PAGAR MUNICIPALIDAD - TRAMITE ITSE-PASAJE', 6.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='PASAJE'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'REC-108' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-108', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'PAGAR MUNICIPALIDAD - TRAMITE ITSE-PASAJE', 'PEN', 6.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'PASAJE'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-109 · COMBUSTIBLE CRISTIAN - FACTU - F277-42744 / F258-166730
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-23', 'egreso', 'COMBUSTIBLE CRISTIAN - FACTU - F277-42744 / F258-166730', 50.40, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='COMBUSTIBLE'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('CRISTIAN') LIMIT 1), 'REC-109' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-109', '2026-10-23', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('CRISTIAN') LIMIT 1), 'COMBUSTIBLE CRISTIAN - FACTU - F277-42744 / F258-166730', 'PEN', 50.40,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'COMBUSTIBLE'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'FACTURA';

-- REC-110 · VITAMINAS MARINA - SPRAY PARA SU GRIPE - PASTILLAS
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'VITAMINAS MARINA - SPRAY PARA SU GRIPE - PASTILLAS', 181.90, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='ANN'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'REC-110' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-110', '2026-10-25', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'VITAMINAS MARINA - SPRAY PARA SU GRIPE - PASTILLAS', 'PEN', 181.90,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'ANN'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-111 · VESTIDO MARINA PARA SU PROMOCION
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'VESTIDO MARINA PARA SU PROMOCION', 185.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='ANN'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'REC-111' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-111', '2026-10-25', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'VESTIDO MARINA PARA SU PROMOCION', 'PEN', 185.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'ANN'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-112 · GUSTITOS - PASAJE GAMARA- SÑRA MARIA
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'GUSTITOS - PASAJE GAMARA- SÑRA MARIA', 55.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='ANN'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'REC-112' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-112', '2026-10-25', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'GUSTITOS - PASAJE GAMARA- SÑRA MARIA', 'PEN', 55.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'ANN'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-113 · BUZO - BRASIER - CORREA - ANN /
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'BUZO - BRASIER - CORREA - ANN /', 106.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='ANN'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'REC-113' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-113', '2026-10-25', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ANN') LIMIT 1), 'BUZO - BRASIER - CORREA - ANN /', 'PEN', 106.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'ANN'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-115 · MERCADO SÑRA NELY / 1 POLLO - TALLARINES*-HUEVO
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'MERCADO SÑRA NELY / 1 POLLO - TALLARINES*-HUEVO', 71.50, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='MERCADO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('NELI') LIMIT 1), 'REC-115' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-115', '2026-10-25', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('NELI') LIMIT 1), 'MERCADO SÑRA NELY / 1 POLLO - TALLARINES*-HUEVO', 'PEN', 71.50,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'MERCADO'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'VALE';

-- REC-116 · PAGO RESTANTE DE PK - 1 MILLAR DE TALONARIO MAS
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'PAGO RESTANTE DE PK - 1 MILLAR DE TALONARIO MAS', 205.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-116' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-116', '2026-10-25', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'PAGO RESTANTE DE PK - 1 MILLAR DE TALONARIO MAS', 'PEN', 205.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-41 · LUIS FACTU F021 - 51333 / MOTO
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'LUIS FACTU F021 - 51333 / MOTO', 60.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='COMBUSTIBLE'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('LUIS PAZ') LIMIT 1), 'REC-41' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-41', '2026-10-25', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('LUIS PAZ') LIMIT 1), 'LUIS FACTU F021 - 51333 / MOTO', 'PEN', 60.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'COMBUSTIBLE'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'FACTURA';

-- REC-119 · VUELTO CL HILARIO VARGAS PK- 18705
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'VUELTO CL HILARIO VARGAS PK- 18705', 28.70, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-119' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-119', '2026-10-25', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'VUELTO CL HILARIO VARGAS PK- 18705', 'PEN', 28.70,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-120 · 5 PAGOS DE OFRECIMIENTO DE PRUEBAS / C/U S/55 - CASO BANBIF
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-26', 'egreso', '5 PAGOS DE OFRECIMIENTO DE PRUEBAS / C/U S/55 - CASO BANBIF', 275.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-120' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-120', '2026-10-26', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, '5 PAGOS DE OFRECIMIENTO DE PRUEBAS / C/U S/55 - CASO BANBIF', 'PEN', 275.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-121 · 7 PAGOS DE DERECHO DE NOTIFICACION CASO BANBIF
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-26', 'egreso', '7 PAGOS DE DERECHO DE NOTIFICACION CASO BANBIF', 39.90, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-121' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-121', '2026-10-26', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, '7 PAGOS DE DERECHO DE NOTIFICACION CASO BANBIF', 'PEN', 39.90,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-122 · CARGADOR CESAR - DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBR
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-26', 'ingreso', 'Ingreso · CARGADOR CESAR - DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUNO', 100.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-122' FROM _cfg;
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-26', 'egreso', 'CARGADOR CESAR - DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUNO', 100.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-122' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-122', '2026-10-26', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'CARGADOR CESAR - DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUNO', 'PEN', 100.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'CARGADORES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-123 · CARGADOR ELIO- DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUN
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-26', 'ingreso', 'Ingreso · CARGADOR ELIO- DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUNO', 80.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-123' FROM _cfg;
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-26', 'egreso', 'CARGADOR ELIO- DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUNO', 80.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='CARGADORES'), NULL, 'REC-123' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-123', '2026-10-26', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'CARGADOR ELIO- DESPACHO 86 CAJAS CL REYNALDO Y 85 CAJAS CLBRUNO', 'PEN', 80.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'CARGADORES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'VALE';

-- REC-124 · PAGO DE TASAS BANBIF - TX DE CUENTA JHIRO
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-26', 'ingreso', 'Ingreso · PAGO DE TASAS BANBIF - TX DE CUENTA JHIRO', 314.90, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-124' FROM _cfg;
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-26', 'egreso', 'PAGO DE TASAS BANBIF - TX DE CUENTA JHIRO', 314.90, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-124' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-124', '2026-10-26', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'PAGO DE TASAS BANBIF - TX DE CUENTA JHIRO', 'PEN', 314.90,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-125 · INQ. MATILTE - PK 18707
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-28', 'egreso', 'INQ. MATILTE - PK 18707', 3.40, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SÑRA MARIA') LIMIT 1), 'REC-125' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-125', '2026-10-28', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SÑRA MARIA') LIMIT 1), 'INQ. MATILTE - PK 18707', 'PEN', 3.40,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-126 · REEMBOLSO SR RAUL PARA PAGAR SU RENOVACION DE LICENCIA
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-28', 'ingreso', 'REEMBOLSO SR RAUL PARA PAGAR SU RENOVACION DE LICENCIA', 20.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='REEMBOLSO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SR RAUL') LIMIT 1), 'REC-126' FROM _cfg;

-- REC-127 · REVALIDACION DE LICENCIA SR RAUL
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-28', 'egreso', 'REVALIDACION DE LICENCIA SR RAUL', 13.20, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), NULL, 'REC-127' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-127', '2026-10-28', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, NULL, 'REVALIDACION DE LICENCIA SR RAUL', 'PEN', 13.20,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-128 · METRO / DETERGENTE/ SHAMPOO -ACONDICIONADOR - 2 PAQUETES DE LE
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-28', 'egreso', 'METRO / DETERGENTE/ SHAMPOO -ACONDICIONADOR - 2 PAQUETES DE LECHE- COMIDA PARA GATO/ TOALLAS/ DOWNIE / JABON/ YOGURT-CEREAL ETC', 676.30, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='MERCADO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'REC-128' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-128', '2026-10-28', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'METRO / DETERGENTE/ SHAMPOO -ACONDICIONADOR - 2 PAQUETES DE LECHE- COMIDA PARA GATO/ TOALLAS/ DOWNIE / JABON/ YOGURT-CEREAL ETC', 'PEN', 676.30,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'MERCADO'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'FACTURA';

-- REC-129 · MERCADO SÑRA MARIA ESPINACA - LECHUGA- ZAPALLO
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-28', 'egreso', 'MERCADO SÑRA MARIA ESPINACA - LECHUGA- ZAPALLO', 20.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='MERCADO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SÑRA MARIA') LIMIT 1), 'REC-129' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-129', '2026-10-28', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SÑRA MARIA') LIMIT 1), 'MERCADO SÑRA MARIA ESPINACA - LECHUGA- ZAPALLO', 'PEN', 20.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'MERCADO'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-130 · IR AL BANCO DEJAR PLANILLA DE LETRAS
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-28', 'egreso', 'IR AL BANCO DEJAR PLANILLA DE LETRAS', 6.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'REC-130' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-130', '2026-10-28', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('ROSARIO') LIMIT 1), 'IR AL BANCO DEJAR PLANILLA DE LETRAS', 'PEN', 6.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-131 · REEMBOLSO SR RAUL YAPEO A CRISTIAN
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-25', 'ingreso', 'REEMBOLSO SR RAUL YAPEO A CRISTIAN', 200.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='REEMBOLSO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SR RAUL') LIMIT 1), 'REC-131' FROM _cfg;

-- REC-132 · VALE CRISTIAN - SR RAUL YAPEO
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-25', 'egreso', 'VALE CRISTIAN - SR RAUL YAPEO', 200.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='VALES'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('CRISTIAN') LIMIT 1), 'REC-132' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-132', '2026-10-25', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('CRISTIAN') LIMIT 1), 'VALE CRISTIAN - SR RAUL YAPEO', 'PEN', 200.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'VALES'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'PLANILLA';

-- REC-133 · MERCADO / SÑRA NELY
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-29', 'egreso', 'MERCADO / SÑRA NELY', 17.30, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='MERCADO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('NELI') LIMIT 1), 'REC-133' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-133', '2026-10-29', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('NELI') LIMIT 1), 'MERCADO / SÑRA NELY', 'PEN', 17.30,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'MERCADO'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';

-- REC-134 · N° 35736 CADFENA MOTO
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-29', 'egreso', 'N° 35736 CADFENA MOTO', 60.00, 'empresa', (SELECT empresa_id FROM _cfg),
         (SELECT id FROM public.categorias_gasto WHERE codigo='OFICINA'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('LUIS PAZ') LIMIT 1), 'REC-134' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-134', '2026-10-29', c.caja_id, 'empresa', (SELECT empresa_id FROM _cfg), b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('LUIS PAZ') LIMIT 1), 'N° 35736 CADFENA MOTO', 'PEN', 60.00,
       td.id, td.sustento_base, 'pendiente', false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'OFICINA'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'FACTURA';

-- REC-135 · REEMBOLSO SR RAUL
INSERT INTO public.movimientos_banco
  (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
SELECT caja_id, '2026-10-29', 'ingreso', 'REEMBOLSO SR RAUL', 3000.00, 'empresa', (SELECT empresa_id FROM _cfg),
       (SELECT id FROM public.categorias_gasto WHERE codigo='REEMBOLSO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('SR RAUL') LIMIT 1), 'REC-135' FROM _cfg;

-- REC-136 · MERCADO
WITH m AS (
  INSERT INTO public.movimientos_banco
    (banco_id, fecha, tipo, concepto, monto, ambito, empresa_id, categoria_gasto_id, responsable_contact_id, referencia)
  SELECT caja_id, '2026-10-29', 'egreso', 'MERCADO', 203.00, 'familiar', NULL,
         (SELECT id FROM public.categorias_gasto WHERE codigo='MERCADO'), (SELECT id FROM public.contacts WHERE upper(nombre)=upper('NELI') LIMIT 1), 'REC-136' FROM _cfg
  RETURNING id)
INSERT INTO public.gastos
  (numero_recibo, fecha, caja_id, ambito, empresa_id, sede_id, destino_costo, categoria_gasto_id,
   responsable_contact_id, detalle, moneda, monto, tipo_documento_id, tipo_sustento, estado_sustento,
   deducible, movimiento_id)
SELECT 'REC-136', '2026-10-29', c.caja_id, 'familiar', NULL, b.sede_id,
       COALESCE(cg.destino_sugerido,'gasto_operativo'), cg.id, (SELECT id FROM public.contacts WHERE upper(nombre)=upper('NELI') LIMIT 1), 'MERCADO', 'PEN', 203.00,
       td.id, td.sustento_base, NULL, false, m.id
  FROM m, _cfg c
  JOIN public.bancos b ON b.id = c.caja_id
  JOIN public.categorias_gasto cg ON cg.codigo = 'MERCADO'
  JOIN public.tipos_documento_gasto td ON td.codigo = 'RECIBO';


COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — debe cuadrar al centavo con el Excel
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. TOTALES' AS bloque,
       sum(ingreso) AS ingresos, sum(egreso) AS egresos, count(*) AS movimientos
  FROM public.v_libro_caja WHERE caja_id = 6 AND fecha BETWEEN '2026-10-22' AND '2026-10-31';

SELECT '2. SALDO DE LA CAJA' AS bloque, nombre, saldo_actual,
       CASE WHEN round(saldo_actual,2) = 1526.03 THEN '✔ CUADRA con el Excel'
            ELSE '⚠ esperado 1526.03' END AS control
  FROM public.bancos WHERE id = 6;

SELECT '3. POR ÁMBITO' AS bloque, ambito, count(*) AS filas, sum(egreso) AS egresos
  FROM public.v_libro_caja WHERE caja_id = 6 GROUP BY ambito ORDER BY ambito;

SELECT '4. PENDIENTES DE FACTURA' AS bloque, numero_recibo, detalle, monto
  FROM public.gastos WHERE estado_sustento = 'pendiente' AND anulado = false;

SELECT '5. TOP CATEGORÍAS' AS bloque, categoria, sum(egreso) AS total
  FROM public.v_libro_caja WHERE caja_id = 6 AND egreso > 0
 GROUP BY categoria ORDER BY total DESC LIMIT 8;
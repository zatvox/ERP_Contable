-- ============================================================================
-- 94_caso_nytex_carpeta14_y_carpeta8.sql  (2026-10-20)
--
-- Dos carpetas reales, cargadas como prueba punta a punta del módulo:
--
--   CARPETA 14 — Proforma Invoice NYTEX NY 2491 (importación que recién inicia)
--     · Proveedor NYTEX PTE LTD (Singapur) — se crea si no existe
--     · OC marcada como importación = la Proforma, confirmada
--         48,600 kg · 150D/48F NIM SD RW  · 1.63 = 79,218.00
--         24,300 kg · 150D/144F SIM SD RW · 1.67 = 40,581.00
--         TOTAL 119,799.00 · CIF CALLAO · anticipo 20% · tolerancia ±10%
--     · Anticipo pagado el 20/10/2026: USD 23,959.80 (= 20% exacto)
--       + comisión 59.89 + SWIFT 12.00 = 24,031.69 desembolsado
--     · Carpeta 14 abierta desde esa OC, en etapa 1
--
--   CARPETA 8 — Compra INVOICE-HY5012261 de ZHEJIANG HENGYI (lote MB31539)
--     · Carpeta + Commercial Invoice con las líneas de detalle_compras
--     · Es el contenedor del Excel de costeo: sirve para comparar el costo
--       que calcula el sistema contra los 1.6444 USD/kg conciliados.
--
-- DECISIONES QUE REFLEJA EL SCRIPT:
--   · El ANTICIPO NO es una línea de costo. Si lo fuera, se contaría dos veces
--     con la mercadería del Commercial Invoice. Queda como documento pagado
--     del expediente; su tratamiento en CxP (compromiso vs cuenta por pagar)
--     sigue pendiente de decidir.
--   · Las COMISIONES BANCARIAS sí entran al ledger: 71.89 como gasto
--     financiero (costo de gestión sí, costo contable NIC 2 no).
--   · CIF ⇒ el precio ya incluye flete y seguro: la carpeta 14 NO lleva
--     líneas de flete ni seguro internacional.
--
-- Idempotente: correrlo dos veces no duplica nada. Al final hay SELECTs de
-- verificación y, comentado, el bloque para deshacer todo.
-- Requiere 86, 87, 90, 92 y 93.
-- ============================================================================
BEGIN;

-- ── La carpeta necesita recordar su incoterm: es lo que decide si el flete
--    ya viene dentro del precio o se carga aparte en el costeo.
ALTER TABLE public.carpetas_importacion
  ADD COLUMN IF NOT EXISTS incoterm varchar;

COMMENT ON COLUMN public.carpetas_importacion.incoterm IS
  'Incoterm de la compra. CIF/CFR/DAP ⇒ el precio del proveedor ya incluye flete y seguro: el ledger NO debe llevarlos. FOB/FCA/EXW ⇒ son líneas de costo aparte.';

COMMIT;

DO $caso$
DECLARE
  v_emp        integer;
  v_nytex      bigint;
  v_zhejiang   bigint;
  v_oc         bigint;
  v_carpeta14  bigint;
  v_carpeta8   bigint;
  v_compra     RECORD;
  v_ci         bigint;
  v_doc        bigint;
  v_item1      bigint;
  v_item2      bigint;
  v_total      numeric := 119799.00;
  v_anticipo   numeric := 23959.80;
  v_lineas     integer := 0;
  r            RECORD;
BEGIN
  -- ══════════════════════════════════════════════════════════════════════
  -- 0. Empresa de trabajo: JHIRO
  -- ══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_emp FROM public.empresa_config WHERE codigo = 'JHIRO';
  IF v_emp IS NULL THEN
    SELECT id INTO v_emp FROM public.empresa_config ORDER BY id LIMIT 1;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- 1. PROVEEDOR NYTEX PTE LTD (Singapur)
  -- ══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_nytex FROM public.contacts
   WHERE nombre ILIKE 'NYTEX%' LIMIT 1;

  IF v_nytex IS NULL THEN
    INSERT INTO public.contacts
      (nombre, tipo_documento, nro_documento, tipo_contacto, direccion, distrito,
       pais, activo, email)
    VALUES
      ('NYTEX PTE LTD', 'otro', 'SG000001', ARRAY['proveedor']::text[],
       '65 CHULIA STREET, LEVEL 46, OCBC CENTRE', 'SINGAPORE 049513',
       'Singapur', true, NULL)
    RETURNING id INTO v_nytex;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- 2. PRODUCTOS: se buscan por nombre; si no están, la línea va sin item_id
  --    (detalle_orden_compra.item_id admite NULL) y se deja la descripción.
  -- ══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_item1 FROM public.items
   WHERE nombre ILIKE '%150%48%' AND (nombre ILIKE '%NIM%' OR nombre ILIKE '%RW%')
   ORDER BY id LIMIT 1;
  SELECT id INTO v_item2 FROM public.items
   WHERE nombre ILIKE '%150%144%' AND (nombre ILIKE '%SIM%' OR nombre ILIKE '%RW%')
   ORDER BY id LIMIT 1;

  -- ══════════════════════════════════════════════════════════════════════
  -- 3. LA OC = PROFORMA INVOICE NY 2491, confirmada
  -- ══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_oc FROM public.orden_compra WHERE numero = 'OC-IMP-NY2491';

  IF v_oc IS NULL THEN
    INSERT INTO public.orden_compra
      (numero, contact_id, fecha, currency, tipo_pago, status,
       cantidad_total, total_subtotal, total_igv, total_OC,
       es_importacion, numero_proforma_proveedor, incoterm,
       puerto_embarque, puerto_destino, pais_origen, marca,
       flete_estimado, seguro_estimado, anticipo_porcentaje,
       tolerancia_porcentaje, dias_validez_anticipo, dias_embarque,
       empresa_id)
    VALUES
      ('OC-IMP-NY2491', v_nytex, DATE '2026-10-19', 'USD', 'credito', 'confirmada',
       72900, v_total, 0, v_total,
       true, 'NY 2491', 'CIF',
       'ANY PORT OF CHINA', 'CALLAO, PERU', 'CHINA', 'HENGYI',
       0, 0, 20,
       10, 2, 20,
       v_emp)
    RETURNING id INTO v_oc;

    -- Línea 1: 150D/48F NIM SD RW — 48,600 kg a 1.63
    INSERT INTO public.detalle_orden_compra
      (orden_compra_id, item_id, descripcion, cantidad, precio_unitario,
       unidad_medida, igv_porcentaje, subtotal, igv_monto, total,
       peso_neto, peso_bruto, partida_arancelaria)
    VALUES
      (v_oc, v_item1, '100% POLYESTER DTY 150D/48F NIM SD RW AA GRADE',
       48600, 1.63, 'KG', 0, 79218.00, 0, 79218.00,
       48600, 48600, '5402.33.00');

    -- Línea 2: 150D/144F SIM SD RW — 24,300 kg a 1.67
    INSERT INTO public.detalle_orden_compra
      (orden_compra_id, item_id, descripcion, cantidad, precio_unitario,
       unidad_medida, igv_porcentaje, subtotal, igv_monto, total,
       peso_neto, peso_bruto, partida_arancelaria)
    VALUES
      (v_oc, v_item2, '100% POLYESTER DTY 150D/144F SIM SD RW AA GRADE',
       24300, 1.67, 'KG', 0, 40581.00, 0, 40581.00,
       24300, 24300, '5402.33.00');
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- 4. CARPETA 14, abierta desde la Proforma
  -- ══════════════════════════════════════════════════════════════════════
  SELECT id INTO v_carpeta14 FROM public.carpetas_importacion WHERE numero_carpeta = '14';

  IF v_carpeta14 IS NULL THEN
    INSERT INTO public.carpetas_importacion
      (numero_carpeta, descripcion, proveedor_id, fecha_apertura,
       fob_total_usd, flete_usd, seguro_usd, cif_total_usd, tipo_cambio,
       estado, moneda_costeo, incoterm, origen, orden_compra_id,
       parametros_snapshot, empresa_id)
    VALUES
      ('14', 'NYTEX PI NY 2491 — 150/48 NIM + 150/144 SIM (72,900 kg)',
       v_nytex, DATE '2026-10-19',
       v_total, 0, 0, v_total, 3.75,
       'abierta', 'USD', 'CIF', 'orden_compra', v_oc,
       (SELECT COALESCE(jsonb_object_agg(clave, valor), '{}'::jsonb)
          FROM public.importacion_parametros WHERE activo AND empresa_id = v_emp),
       v_emp)
    RETURNING id INTO v_carpeta14;

    UPDATE public.orden_compra SET carpeta_importacion_id = v_carpeta14 WHERE id = v_oc;
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- 5. EL ANTICIPO PAGADO — 20/10/2026, operación BCP 107586862
  -- ══════════════════════════════════════════════════════════════════════
  -- El anticipo NO va al ledger de costos: la mercadería ya entrará por el
  -- Commercial Invoice y se contaría dos veces. Queda como documento pagado
  -- del expediente.
  SELECT id INTO v_doc FROM public.documentos_importacion
   WHERE numero = '107586862' AND proveedor_id = v_nytex;

  IF v_doc IS NULL THEN
    INSERT INTO public.documentos_importacion
      (tipo, serie, numero, proveedor_id, fecha_emision, moneda, tipo_cambio,
       monto_sin_igv, igv_monto, monto_total, estado_pago, es_provisional,
       sustentado, observaciones, empresa_id)
    VALUES
      ('voucher_bancario', NULL, '107586862', v_nytex, DATE '2026-10-20', 'USD', 3.75,
       v_anticipo, 0, v_anticipo, 'pagado', false, true,
       'Anticipo 20% PI NY 2491 — transferencia BCP cta. 191-7078532-1-31 → NYTEX. Ref: ADVANCE PROFORMA INVOICE NY 2491. No es linea de costo: la mercaderia entra por el Commercial Invoice.',
       v_emp)
    RETURNING id INTO v_doc;
  END IF;

  -- Las comisiones bancarias SÍ son costo (de gestión, no NIC 2)
  IF NOT EXISTS (SELECT 1 FROM public.importacion_costos
                  WHERE carpeta_importacion_id = v_carpeta14
                    AND concepto_codigo = 'comision_bancaria') THEN
    INSERT INTO public.documentos_importacion
      (tipo, numero, proveedor_id, fecha_emision, moneda, tipo_cambio,
       monto_sin_igv, igv_monto, monto_total, estado_pago, sustentado,
       observaciones, empresa_id)
    VALUES
      ('voucher_bancario', '107586862-COM', NULL, DATE '2026-10-20', 'USD', 3.75,
       71.89, 0, 71.89, 'pagado', true,
       'Comision de transferencia 59.89 + SWIFT 12.00 del anticipo PI NY 2491',
       v_emp)
    RETURNING id INTO v_doc;

    INSERT INTO public.importacion_costos
      (carpeta_importacion_id, documento_id, grupo, concepto, concepto_codigo,
       clasificacion, moneda, tipo_cambio, monto_moneda, base_prorrateo,
       observaciones)
    VALUES
      (v_carpeta14, v_doc, 'financiero',
       'Comision transferencia + SWIFT (anticipo 20%)', 'comision_bancaria',
       'gasto_financiero', 'USD', 3.75, 71.89, 'valor_fob',
       'BCP 20/10/2026 - operacion 107586862. 59.89 + 12.00');
  END IF;

  -- ══════════════════════════════════════════════════════════════════════
  -- 6. CARPETA 8 — compra INVOICE-HY5012261 de ZHEJIANG HENGYI (lote MB31539)
  -- ══════════════════════════════════════════════════════════════════════
  SELECT c.* INTO v_compra
    FROM public.compras c
   WHERE (c.numero = 'HY5012261' OR c.referencia ILIKE '%HY5012261%')
     AND c.comprobante_anulado IS NOT TRUE
   ORDER BY c.id LIMIT 1;

  -- FOUND es mas seguro que mirar v_compra.id cuando no hubo fila
  IF FOUND THEN
    SELECT id INTO v_carpeta8 FROM public.carpetas_importacion WHERE numero_carpeta = '8';

    IF v_carpeta8 IS NULL THEN
      INSERT INTO public.carpetas_importacion
        (numero_carpeta, descripcion, proveedor_id, fecha_apertura,
         fob_total_usd, cif_total_usd, tipo_cambio, estado, moneda_costeo,
         incoterm, origen, compra_origen_id, numero_dam,
         parametros_snapshot, empresa_id)
      VALUES
        ('8', 'ZHEJIANG HENGYI — 150/48 RW NIM — lote MB31539 (DAM 436155)',
         v_compra.contact_id, v_compra.fecha_emision,
         v_compra.subtotal, v_compra.subtotal,
         COALESCE(v_compra.tipo_cambio, 3.368), 'abierta', 'USD',
         'CIF', 'compra', v_compra.id, '118-2026-10-436155-00',
         (SELECT COALESCE(jsonb_object_agg(clave, valor), '{}'::jsonb)
            FROM public.importacion_parametros WHERE activo AND empresa_id = v_emp),
         COALESCE(v_compra.empresa_id, v_emp))
      RETURNING id INTO v_carpeta8;

      -- Commercial Invoice con las líneas de la compra
      INSERT INTO public.comercial_invoices
        (contact_id, invoice_number, fecha, product, terminos_delivery,
         cantidad_total_neto, valor_total_final_ci, valor_total_final_fob,
         carpeta_importacion_id, status, empresa_id)
      SELECT v_compra.contact_id,
             COALESCE(NULLIF(TRIM(CONCAT_WS('-', v_compra.serie, v_compra.numero)), ''), v_compra.referencia),
             v_compra.fecha_emision,
             '150/48 RW NIM', 'CIF',
             COALESCE(SUM(d.cantidad), 0), COALESCE(SUM(d.subtotal), 0), COALESCE(SUM(d.subtotal), 0),
             v_carpeta8, 'confirmado', COALESCE(v_compra.empresa_id, v_emp)
        FROM public.detalle_compras d WHERE d.compra_id = v_compra.id
      RETURNING id INTO v_ci;

      UPDATE public.carpetas_importacion SET comercial_invoice_id = v_ci WHERE id = v_carpeta8;

      INSERT INTO public.detalle_comercial_invoice
        (comercial_invoice_id, product_id, lote, cantidad_neto, cantidad_gross,
         cantidad_unid, costo_unitario, costo_total)
      SELECT v_ci, d.item_id, 'MB31539', d.cantidad, d.cantidad, 0,
             d.precio_unitario, d.subtotal
        FROM public.detalle_compras d WHERE d.compra_id = v_compra.id;
      GET DIAGNOSTICS v_lineas = ROW_COUNT;

      UPDATE public.compras SET carpeta_importacion_id = v_carpeta8 WHERE id = v_compra.id;
    END IF;
  END IF;
END;
$caso$;

-- ============================================================================
-- VERIFICACIÓN
-- ============================================================================
-- 1 · Las dos carpetas
SELECT numero_carpeta, descripcion, estado, incoterm, origen,
       fob_total_usd, cif_total_usd, numero_dam
  FROM public.carpetas_importacion
 WHERE numero_carpeta IN ('8','14')
 ORDER BY numero_carpeta;

-- 2 · La Proforma Invoice con sus líneas
SELECT o.numero, o.numero_proforma_proveedor, o.incoterm, o.status,
       o.anticipo_porcentaje, o.tolerancia_porcentaje, o.total_OC,
       d.descripcion, d.cantidad, d.precio_unitario, d.subtotal, d.peso_neto
  FROM public.orden_compra o
  JOIN public.detalle_orden_compra d ON d.orden_compra_id = o.id
 WHERE o.numero = 'OC-IMP-NY2491'
 ORDER BY d.id;

-- 3 · El anticipo y las comisiones
SELECT tipo, numero, fecha_emision, moneda, monto_total, estado_pago, observaciones
  FROM public.documentos_importacion
 WHERE numero LIKE '107586862%'
 ORDER BY numero;

-- 4 · El costo por artículo de la carpeta 8 (compara contra tu Excel)
SELECT empresa_codigo, numero_carpeta, articulo, peso_neto,
       costo_contable_kg, costo_kg AS costo_gestion_kg, stock
  FROM public.v_importacion_analisis_general
 WHERE numero_carpeta IN ('8','14')
 ORDER BY numero_carpeta, articulo;

-- 5 · El cuadre del prorrateo (cuadra debe ser true)
SELECT numero_carpeta, ledger_contable_usd, repartido_contable_usd,
       dif_contable_usd, lineas_ci, lineas_sin_base, cuadra
  FROM public.v_importacion_prorrateo_cuadre
 WHERE numero_carpeta IN ('8','14');

-- ============================================================================
-- DESHACER (descomentar solo si querés borrar el caso de prueba)
-- ============================================================================
-- DO $undo$
-- DECLARE v14 bigint; v8 bigint; voc bigint; vci bigint;
-- BEGIN
--   SELECT id INTO v14 FROM public.carpetas_importacion WHERE numero_carpeta = '14';
--   SELECT id INTO v8  FROM public.carpetas_importacion WHERE numero_carpeta = '8';
--   SELECT id INTO voc FROM public.orden_compra WHERE numero = 'OC-IMP-NY2491';
--   SELECT comercial_invoice_id INTO vci FROM public.carpetas_importacion WHERE id = v8;
--   UPDATE public.compras      SET carpeta_importacion_id = NULL WHERE carpeta_importacion_id IN (v8, v14);
--   UPDATE public.orden_compra SET carpeta_importacion_id = NULL WHERE id = voc;
--   UPDATE public.carpetas_importacion SET comercial_invoice_id = NULL WHERE id IN (v8, v14);
--   DELETE FROM public.detalle_comercial_invoice WHERE comercial_invoice_id = vci;
--   DELETE FROM public.comercial_invoices WHERE id = vci;
--   DELETE FROM public.importacion_costos WHERE carpeta_importacion_id IN (v8, v14);
--   DELETE FROM public.documentos_importacion WHERE numero LIKE '107586862%';
--   DELETE FROM public.detalle_orden_compra WHERE orden_compra_id = voc;
--   DELETE FROM public.orden_compra WHERE id = voc;
--   DELETE FROM public.carpetas_importacion WHERE id IN (v8, v14);
-- END;
-- $undo$;

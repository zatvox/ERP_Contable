-- ============================================================================
-- 152_sincronizar_comprobante_cxc_cxp_con_documento.sql  (2026-11-09)
-- Caso: la CxC #200 (IMPORTACION TEXTIL FSR, USD 14,688.00, 13/01/2026) decía
-- "F001-1" pero su venta (#280) es FFFI-262. La CxC copia serie/número de la
-- venta al crearse; si después la venta cambió de serie/correlativo por una vía
-- que no actualizó la CxC, quedaron desalineadas (revisado: es el único caso;
-- en CxP no hay ninguno).
--
-- Regla (prevenir por diseño): el N° de comprobante de una CxC/CxP NO se
-- digita, se HEREDA del documento. Triggers:
--   · ventas  → cuentas_cobrar (serie, número, tipo) al cambiar la venta
--   · compras → cuentas_pagar  (serie, número, tipo) al cambiar la compra
--   · cuentas_cobrar/pagar: si tienen venta/compra, al insertar o editar se
--     fuerzan los datos del documento (nadie puede dejarlos distintos).
-- ============================================================================

-- 1) VISTA PREVIA: CxC / CxP que no coinciden con su documento
SELECT 'CxC' AS lado, c.id, c.serie || '-' || c.numero_comprobante AS dice, v.serie || '-' || v.correlativo AS deberia
FROM public.cuentas_cobrar c JOIN public.ventas v ON v.id = c.venta_id
WHERE c.serie IS DISTINCT FROM v.serie OR ltrim(c.numero_comprobante, '0') IS DISTINCT FROM ltrim(v.correlativo, '0')
UNION ALL
SELECT 'CxP', p.id, COALESCE(p.serie, '') || '-' || p.numero_comprobante, COALESCE(co.serie, '') || '-' || co.numero
FROM public.cuentas_pagar p JOIN public.compras co ON co.id = p.compra_id
WHERE p.serie IS DISTINCT FROM co.serie OR ltrim(p.numero_comprobante, '0') IS DISTINCT FROM ltrim(co.numero, '0');

-- 2) CORRECCIÓN + TRIGGERS (bloque único)
BEGIN;

CREATE OR REPLACE FUNCTION public.fn_num_sin_ceros(x text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN x ~ '^[0-9]{1,8}$' THEN COALESCE(NULLIF(ltrim(x, '0'), ''), '0') ELSE x END
$$;

-- 2.1 Corrige lo existente
UPDATE public.cuentas_cobrar c
   SET serie = v.serie, numero_comprobante = public.fn_num_sin_ceros(v.correlativo), tipo_comprobante = v.tipo_comprobante
  FROM public.ventas v
 WHERE v.id = c.venta_id
   AND (c.serie IS DISTINCT FROM v.serie OR ltrim(c.numero_comprobante, '0') IS DISTINCT FROM ltrim(v.correlativo, '0'));

UPDATE public.cuentas_pagar p
   SET serie = co.serie, numero_comprobante = public.fn_num_sin_ceros(co.numero), tipo_comprobante = co.tipo_comprobante
  FROM public.compras co
 WHERE co.id = p.compra_id
   AND (p.serie IS DISTINCT FROM co.serie OR ltrim(p.numero_comprobante, '0') IS DISTINCT FROM ltrim(co.numero, '0'));

-- 2.2 La CxC/CxP hereda del documento al insertarse o editarse
CREATE OR REPLACE FUNCTION public.fn_cxc_hereda_venta() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
  IF NEW.venta_id IS NOT NULL THEN
    SELECT serie, correlativo, tipo_comprobante INTO v FROM public.ventas WHERE id = NEW.venta_id;
    IF FOUND THEN
      NEW.serie := v.serie;
      NEW.numero_comprobante := public.fn_num_sin_ceros(v.correlativo);
      NEW.tipo_comprobante := COALESCE(v.tipo_comprobante, NEW.tipo_comprobante);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cxc_hereda_venta ON public.cuentas_cobrar;
CREATE TRIGGER trg_cxc_hereda_venta BEFORE INSERT OR UPDATE OF venta_id, serie, numero_comprobante, tipo_comprobante ON public.cuentas_cobrar
  FOR EACH ROW EXECUTE FUNCTION public.fn_cxc_hereda_venta();

CREATE OR REPLACE FUNCTION public.fn_cxp_hereda_compra() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c record;
BEGIN
  IF NEW.compra_id IS NOT NULL THEN
    SELECT serie, numero, tipo_comprobante INTO c FROM public.compras WHERE id = NEW.compra_id;
    IF FOUND AND c.numero IS NOT NULL THEN
      NEW.serie := c.serie;
      NEW.numero_comprobante := public.fn_num_sin_ceros(c.numero);
      NEW.tipo_comprobante := COALESCE(c.tipo_comprobante, NEW.tipo_comprobante);
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_cxp_hereda_compra ON public.cuentas_pagar;
CREATE TRIGGER trg_cxp_hereda_compra BEFORE INSERT OR UPDATE OF compra_id, serie, numero_comprobante, tipo_comprobante ON public.cuentas_pagar
  FOR EACH ROW EXECUTE FUNCTION public.fn_cxp_hereda_compra();

-- 2.3 Si cambia la venta/compra, su CxC/CxP se actualiza sola
CREATE OR REPLACE FUNCTION public.fn_venta_propaga_cxc() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.cuentas_cobrar SET serie = NEW.serie WHERE venta_id = NEW.id;   -- el trigger de la CxC completa número y tipo
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_venta_propaga_cxc ON public.ventas;
CREATE TRIGGER trg_venta_propaga_cxc AFTER UPDATE OF serie, correlativo, tipo_comprobante ON public.ventas
  FOR EACH ROW WHEN (OLD.serie IS DISTINCT FROM NEW.serie OR OLD.correlativo IS DISTINCT FROM NEW.correlativo OR OLD.tipo_comprobante IS DISTINCT FROM NEW.tipo_comprobante)
  EXECUTE FUNCTION public.fn_venta_propaga_cxc();

CREATE OR REPLACE FUNCTION public.fn_compra_propaga_cxp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.cuentas_pagar SET serie = NEW.serie WHERE compra_id = NEW.id;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_compra_propaga_cxp ON public.compras;
CREATE TRIGGER trg_compra_propaga_cxp AFTER UPDATE OF serie, numero, tipo_comprobante ON public.compras
  FOR EACH ROW WHEN (OLD.serie IS DISTINCT FROM NEW.serie OR OLD.numero IS DISTINCT FROM NEW.numero OR OLD.tipo_comprobante IS DISTINCT FROM NEW.tipo_comprobante)
  EXECUTE FUNCTION public.fn_compra_propaga_cxp();

COMMIT;

-- 3) VERIFICACIÓN: el paso 1 debe salir vacío y la CxC 200 decir FFFI-262
SELECT id, serie || '-' || numero_comprobante AS comprobante, monto_total FROM public.cuentas_cobrar WHERE id = 200;

-- 4) DIAGNÓSTICO (solo lectura): ventas que siguen con ceros a la izquierda.
--    Si sale > 0, el paso 3 del SQL 96 no se aplicó en ventas.
SELECT count(*) AS ventas_con_ceros FROM public.ventas WHERE correlativo ~ '^0[0-9]{1,7}$';

-- ============================================================================
-- 59_series_documentos_y_packing.sql · 2026-09-30
-- 1) series_documentos: tabla ÚNICA de series y correlativos (Ventas).
--    Reemplaza a los parámetros sueltos serieFactura/serieBoleta/serieNC…
--    que vivían en el navegador (localStorage) → ahora son de la BD, iguales
--    para todos los usuarios/PCs.
--      tipo_documento: 'PK' (Packing / cotización), '01' Factura, '03' Boleta,
--                      '07' Nota de Crédito, '08' Nota de Débito
--      es_cpe:        true = se envía a NUBEFACT · false = comprobante físico
--                      (ej. NV01 = Factura tipo 01 física: suma IGV normal)
--      aplica_a:      solo NC/ND: tipo del comprobante que modifican ('01'/'03')
--      dias_validez:  solo PK (validez de la cotización, por defecto 15)
--    Siguiente número = MAYOR( ultimo_correlativo, correlativo_inicial - 1,
--                              máximo ya usado en la tabla del documento ) + 1
--    → aunque alguien escriba un número a mano, nunca se repite.
-- 2) packing + detalle_packing: el PK es donde inicia el flujo de almacén.
--    Etapa 1: PK de VENTA (cotización/orden de venta → 1 factura).
--    tipo queda preparado para 'traslado' y 'servicio' (etapas futuras).
-- 3) ventas.packing_id: enlace factura ← PK.
-- La tabla vieja sales_quotes (0 registros, 1 sola línea) NO se toca.
-- ============================================================================
BEGIN;

-- ── 1) SERIES ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.series_documentos (
  id                  bigserial   PRIMARY KEY,
  tipo_documento      varchar     NOT NULL CHECK (tipo_documento IN ('PK','01','03','07','08')),
  serie               varchar     NOT NULL,
  descripcion         varchar,
  correlativo_inicial integer     NOT NULL DEFAULT 1 CHECK (correlativo_inicial >= 1),
  ultimo_correlativo  integer     NOT NULL DEFAULT 0 CHECK (ultimo_correlativo >= 0),
  digitos             integer     NOT NULL DEFAULT 8 CHECK (digitos BETWEEN 3 AND 10),
  es_cpe              boolean     NOT NULL DEFAULT true,
  aplica_a            varchar     CHECK (aplica_a IN ('01','03')),
  dias_validez        integer     CHECK (dias_validez IS NULL OR dias_validez > 0),
  por_defecto         boolean     NOT NULL DEFAULT false,
  activo              boolean     NOT NULL DEFAULT true,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now(),
  UNIQUE (tipo_documento, serie)
);
COMMENT ON TABLE public.series_documentos IS
  'Series y correlativos del módulo Ventas (PK, 01, 03, 07, 08). Ver 59_series_documentos_y_packing.sql.';

-- Una sola serie por defecto por tipo (+ aplica_a para NC/ND)
CREATE UNIQUE INDEX IF NOT EXISTS ux_series_default
  ON public.series_documentos (tipo_documento, COALESCE(aplica_a, '')) WHERE por_defecto;

-- Carga inicial: series reales en uso (último correlativo leído de ventas)
WITH usados AS (
  SELECT tipo_comprobante AS t, serie,
         MAX(NULLIF(regexp_replace(COALESCE(correlativo, ''), '\D', '', 'g'), '')::int) AS ult
  FROM public.ventas WHERE serie IS NOT NULL GROUP BY 1, 2
)
INSERT INTO public.series_documentos
  (tipo_documento, serie, descripcion, correlativo_inicial, ultimo_correlativo, digitos, es_cpe, aplica_a, dias_validez, por_defecto)
VALUES
  ('PK', 'PK',   'Packing / Cotización de venta', 18642, 18641, 6, false, NULL, 15,   true),
  ('01', 'FFFI', 'Factura electrónica',           1, COALESCE((SELECT ult FROM usados WHERE t='01' AND serie='FFFI'),0), 8, true,  NULL, NULL, true),
  ('01', 'NV01', 'Factura física (no se envía a SUNAT)', 1, COALESCE((SELECT ult FROM usados WHERE t='01' AND serie='NV01'),0), 8, false, NULL, NULL, false),
  ('03', 'BBOL', 'Boleta electrónica',            1, COALESCE((SELECT ult FROM usados WHERE t='03' AND serie='BBOL'),0), 8, true,  NULL, NULL, true),
  ('07', 'FNC1', 'NC sobre Factura',              1, COALESCE((SELECT ult FROM usados WHERE t='07' AND serie='FNC1'),0), 8, true,  '01', NULL, true),
  ('07', 'BBCC', 'NC sobre Boleta',               1, COALESCE((SELECT ult FROM usados WHERE t='07' AND serie='BBCC'),0), 8, true,  '03', NULL, true),
  ('08', 'FNDI', 'ND sobre Factura',              1, COALESCE((SELECT ult FROM usados WHERE t='08' AND serie='FNDI'),0), 8, true,  '01', NULL, true)
ON CONFLICT (tipo_documento, serie) DO NOTHING;

-- ── 2) PACKING (PK) ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.packing (
  id                   bigserial   PRIMARY KEY,
  tipo                 varchar     NOT NULL DEFAULT 'venta' CHECK (tipo IN ('venta','traslado','servicio')),
  serie                varchar     NOT NULL DEFAULT 'PK',
  correlativo          integer     NOT NULL,
  numero               varchar     NOT NULL UNIQUE,            -- PK-018642
  contact_id           bigint      REFERENCES public.contacts(id),
  fecha_emision        date        NOT NULL DEFAULT CURRENT_DATE,
  fecha_validez        date,
  moneda               varchar     NOT NULL DEFAULT 'PEN' CHECK (moneda IN ('PEN','USD')),
  tipo_cambio          numeric     DEFAULT 1,
  termino_pago_id      bigint,
  vendedor_id          bigint,
  orden_compra_cliente varchar,
  observaciones        text,                                   -- nota general (sale en el PDF)
  subtotal             numeric     NOT NULL DEFAULT 0,
  igv                  numeric     NOT NULL DEFAULT 0,
  total                numeric     NOT NULL DEFAULT 0,
  estado               varchar     NOT NULL DEFAULT 'borrador'
                         CHECK (estado IN ('borrador','enviado','facturado','anulado')),
  venta_id             bigint      REFERENCES public.ventas(id) ON DELETE SET NULL,
  created_by           bigint      REFERENCES public.users(id),
  created_at           timestamptz DEFAULT now(),
  updated_at           timestamptz DEFAULT now(),
  UNIQUE (serie, correlativo)
);
COMMENT ON TABLE public.packing IS
  'Packing (PK): documento donde inicia el flujo de almacén. Etapa 1 = tipo venta (cotización/orden de venta → 1 factura).';

CREATE TABLE IF NOT EXISTS public.detalle_packing (
  id                bigserial   PRIMARY KEY,
  packing_id        bigint      NOT NULL REFERENCES public.packing(id) ON DELETE CASCADE,
  orden             integer     NOT NULL DEFAULT 0,
  item_id           bigint      REFERENCES public.items(id),
  descripcion       varchar     NOT NULL,
  nota              varchar,                                   -- ej. "18 BOLSAS (24.50 KG X BOLSA)"
  cantidad          numeric     NOT NULL CHECK (cantidad > 0),
  unidad_medida     varchar     NOT NULL DEFAULT 'KG',
  cantidad_unidades numeric     NOT NULL DEFAULT 0,
  precio_unitario   numeric     NOT NULL DEFAULT 0,            -- SIN IGV (igual que detalle_ventas)
  tipo_base         varchar     NOT NULL DEFAULT 'gravada'
                      CHECK (tipo_base IN ('gravada','exonerada','inafecta','exportacion')),
  igv_porcentaje    numeric     NOT NULL DEFAULT 18,
  subtotal          numeric     NOT NULL DEFAULT 0,
  igv_monto         numeric     NOT NULL DEFAULT 0,
  total_linea       numeric     NOT NULL DEFAULT 0,
  created_at        timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_detalle_packing_packing ON public.detalle_packing(packing_id);

-- ── 3) Enlace factura ← PK ─────────────────────────────────────────────────
ALTER TABLE public.ventas ADD COLUMN IF NOT EXISTS packing_id bigint REFERENCES public.packing(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ventas_packing ON public.ventas(packing_id);

-- ── 4) RLS + GRANTS (mismo patrón que 56) ──────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['series_documentos','packing','detalle_packing'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t||'_all_auth', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (true) WITH CHECK (true)', t||'_all_auth', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
  END LOOP;
END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;

COMMIT;

-- ── VERIFICACIÓN ───────────────────────────────────────────────────────────
SELECT tipo_documento, serie, descripcion, correlativo_inicial, ultimo_correlativo,
       digitos, es_cpe, aplica_a, dias_validez, por_defecto
FROM public.series_documentos ORDER BY tipo_documento, serie;

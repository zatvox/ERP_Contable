-- ============================================================================
-- 125 · TESORERÍA — Libro de caja estilo Excel  ·  2026-10-31
-- ----------------------------------------------------------------------------
-- La tesorera no quiere un formulario: quiere su hoja. Esto es lo que le falta
-- a la base para que una GRILLA EDITABLE se comporte como su Excel.
--
--   tipos_documento_gasto  → la columna "Tipo Doc" deja de ser una lista fija
--                            y pasa a catálogo que ella misma edita
--   color                  → los chips de colores (ANN amarillo, ROSARIO rosa…)
--                            no son adorno: así reconoce la fila de un vistazo
--   gastos.nota            → los triangulitos rojos de su columna N° Recibo
--   v_libro_caja           → UNA sola lectura que trae ingresos y egresos
--                            juntos, como su pestaña "CAJA"
--
-- POR QUÉ UN CATÁLOGO Y NO UN CHECK MÁS GRANDE: la etiqueta que ella ve es
-- libre ("Reembolso", "Vale de caja", "Ticket"), pero el TRATAMIENTO TRIBUTARIO
-- es finito (factura / boleta / RH / vale / sin documento). Cada fila del
-- catálogo apunta a su tratamiento base. Así puede inventar etiquetas sin que
-- nadie pueda crear por accidente un "documento" que deduzca sin sustento.
--
-- Requiere el SQL 123 y el 124. IDEMPOTENTE. NO BORRA NADA.
-- ============================================================================

BEGIN;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 1 · Catálogo editable de "Tipo Doc"
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.tipos_documento_gasto (
  id                 serial      PRIMARY KEY,
  codigo             varchar     NOT NULL UNIQUE,
  nombre             varchar     NOT NULL,
  -- El tratamiento tributario real detrás de la etiqueta
  sustento_base      varchar     NOT NULL DEFAULT 'sin_documento',
  color              varchar     NOT NULL DEFAULT '#64748b',
  orden              integer     NOT NULL DEFAULT 100,
  activo             boolean     NOT NULL DEFAULT true,
  created_at         timestamptz DEFAULT now()
);

COMMENT ON TABLE public.tipos_documento_gasto IS
  'Columna "Tipo Doc" del Excel de la tesorera. Etiqueta libre, tratamiento tributario acotado por sustento_base.';
COMMENT ON COLUMN public.tipos_documento_gasto.sustento_base IS
  'El tratamiento que realmente aplica. Ella inventa la etiqueta; esto decide si deduce o no.';
COMMENT ON COLUMN public.tipos_documento_gasto.color IS
  'Color del chip en la grilla. Hex (#RRGGBB).';

ALTER TABLE public.tipos_documento_gasto DROP CONSTRAINT IF EXISTS ck_tipodoc_sustento;
ALTER TABLE public.tipos_documento_gasto ADD CONSTRAINT ck_tipodoc_sustento
  CHECK (sustento_base IN ('factura','boleta','recibo_honorarios','vale','sin_documento'));

ALTER TABLE public.tipos_documento_gasto DROP CONSTRAINT IF EXISTS ck_tipodoc_color;
ALTER TABLE public.tipos_documento_gasto ADD CONSTRAINT ck_tipodoc_color
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$');

-- Semilla: los tipos del Excel real (col. "Tipo Doc"), con sus colores
INSERT INTO public.tipos_documento_gasto (codigo, nombre, sustento_base, color, orden) VALUES
  ('FACTURA',  'Factura',              'factura',           '#16a34a',  10),
  ('BOLETA',   'Boleta',               'boleta',            '#2563eb',  20),
  ('RH',       'Recibo por honorarios','recibo_honorarios', '#7c3aed',  30),
  ('RECIBO',   'Recibo',               'sin_documento',     '#64748b',  40),
  ('VALE',     'Vale',                 'vale',              '#ea580c',  50),
  ('TICKET',   'Ticket',               'sin_documento',     '#0891b2',  60),
  ('SIN_DOC',  'Sin documento',        'sin_documento',     '#dc2626',  70)
ON CONFLICT (codigo) DO NOTHING;

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 2 · Colores en las categorías + "Reembolso" como categoría
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.categorias_gasto
  ADD COLUMN IF NOT EXISTS color varchar NOT NULL DEFAULT '#64748b';

ALTER TABLE public.categorias_gasto DROP CONSTRAINT IF EXISTS ck_catgasto_color;
ALTER TABLE public.categorias_gasto ADD CONSTRAINT ck_catgasto_color
  CHECK (color ~ '^#[0-9A-Fa-f]{6}$');

-- Colores tomados del Excel de la tesorera, para que no tenga que reaprenderlos
UPDATE public.categorias_gasto SET color = v.color FROM (VALUES
  ('OFICINA',     '#0891b2'),
  ('FERRETERIA',  '#78716c'),
  ('SERVICIOS',   '#0d9488'),
  ('SUNAT_MUNI',  '#b45309'),
  ('LEGAL',       '#4f46e5'),
  ('COMBUSTIBLE', '#dc2626'),
  ('CARGADORES',  '#9333ea'),
  ('PEAJES',      '#be123c'),
  ('PASAJE',      '#c026d3'),
  ('ALIMENTACION','#65a30d'),
  ('MERCADO',     '#16a34a'),
  ('VALES',       '#a21caf'),
  ('REEMBOLSO',   '#15803d'),
  ('SALUD_FAM',   '#e11d48'),
  ('EDUCACION',   '#2563eb'),
  ('HOGAR',       '#ea580c'),
  ('OTROS',       '#64748b')
) AS v(codigo, color) WHERE categorias_gasto.codigo = v.codigo AND categorias_gasto.color = '#64748b';

-- "REEMBOLSO" ya existe como categoría desde el SQL 123 (decisión 2026-10-31:
-- en el Excel estaba mal puesto como Tipo Doc — no es un documento, es la
-- naturaleza de la operación).

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 3 · Gastos: tipo de documento y nota de celda
-- ════════════════════════════════════════════════════════════════════════════
ALTER TABLE public.gastos
  ADD COLUMN IF NOT EXISTS tipo_documento_id integer REFERENCES public.tipos_documento_gasto(id),
  ADD COLUMN IF NOT EXISTS nota              text;

COMMENT ON COLUMN public.gastos.tipo_documento_id IS
  'Etiqueta visible ("Tipo Doc"). El tratamiento tributario sigue viviendo en tipo_sustento, que se deriva de tipos_documento_gasto.sustento_base.';
COMMENT ON COLUMN public.gastos.nota IS
  'Nota libre de la fila — el equivalente al comentario de celda del Excel (triangulito rojo).';

-- Backfill: los gastos existentes toman el tipo que corresponda a su sustento
UPDATE public.gastos g SET tipo_documento_id = t.id
  FROM public.tipos_documento_gasto t
 WHERE g.tipo_documento_id IS NULL
   AND t.sustento_base = g.tipo_sustento
   AND t.codigo IN ('FACTURA','BOLETA','RH','VALE','SIN_DOC');

-- Trigger: tipo_sustento SIEMPRE se deriva del catálogo.
-- Es lo que impide que una etiqueta nueva ("Ticket de peaje") termine
-- deduciendo sin comprobante sólo porque alguien la creó con otro nombre.
CREATE OR REPLACE FUNCTION public.fn_gastos_derivar_sustento()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_base varchar;
BEGIN
  IF NEW.tipo_documento_id IS NOT NULL THEN
    SELECT sustento_base INTO v_base FROM public.tipos_documento_gasto WHERE id = NEW.tipo_documento_id;
    IF v_base IS NOT NULL THEN
      NEW.tipo_sustento := v_base;
      IF v_base = 'sin_documento' THEN NEW.deducible := false; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_gastos_derivar_sustento ON public.gastos;
CREATE TRIGGER trg_gastos_derivar_sustento
  BEFORE INSERT OR UPDATE OF tipo_documento_id ON public.gastos
  FOR EACH ROW EXECUTE FUNCTION public.fn_gastos_derivar_sustento();

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 4 · VISTA v_libro_caja — ingresos y egresos juntos, como su hoja
-- ════════════════════════════════════════════════════════════════════════════
-- La grilla lee SOLO de aquí. Un movimiento de caja puede o no tener un gasto
-- detrás: los egresos de caja chica sí, un cobro de cliente o una reposición no.
-- El saldo corrido NO se calcula aquí a propósito: depende del orden y de los
-- filtros que el usuario tenga puestos, así que lo calcula el front.
DROP VIEW IF EXISTS public.v_libro_caja;
CREATE VIEW public.v_libro_caja AS
SELECT
  m.id                       AS movimiento_id,
  g.id                       AS gasto_id,
  m.banco_id                 AS caja_id,
  b.nombre                   AS caja_nombre,
  b.moneda                   AS moneda,
  m.fecha                    AS fecha,
  to_char(m.fecha, 'TMMonth')AS mes_nombre,
  COALESCE(g.numero_recibo, m.referencia)        AS numero_recibo,
  g.tipo_documento_id,
  td.nombre                  AS tipo_documento,
  td.color                   AS tipo_documento_color,
  COALESCE(g.categoria_gasto_id, m.categoria_gasto_id) AS categoria_gasto_id,
  cg.nombre                  AS categoria,
  cg.color                   AS categoria_color,
  COALESCE(g.responsable_contact_id, m.responsable_contact_id) AS responsable_contact_id,
  c.nombre                   AS responsable,
  COALESCE(g.detalle, m.concepto) AS detalle,
  CASE WHEN m.tipo = 'ingreso' THEN m.monto ELSE 0 END AS ingreso,
  CASE WHEN m.tipo = 'egreso'  THEN m.monto ELSE 0 END AS egreso,
  m.tipo                     AS tipo_movimiento,
  COALESCE(g.ambito, m.ambito)         AS ambito,
  COALESCE(g.empresa_id, m.empresa_id) AS empresa_id,
  g.destino_costo,
  g.tipo_sustento,
  g.estado_sustento,
  g.deducible,
  g.guia_despacho_id,
  g.entrega_id,
  g.reposicion_id,
  g.nota,
  g.observaciones,
  (SELECT count(*) FROM public.adjuntos a
    WHERE a.entidad = 'gasto' AND a.entidad_id = g.id) AS adjuntos,
  m.created_at
FROM public.movimientos_banco m
JOIN      public.bancos               b  ON b.id  = m.banco_id
LEFT JOIN public.gastos               g  ON g.movimiento_id = m.id AND g.anulado = false
LEFT JOIN public.tipos_documento_gasto td ON td.id = g.tipo_documento_id
LEFT JOIN public.categorias_gasto     cg ON cg.id = COALESCE(g.categoria_gasto_id, m.categoria_gasto_id)
LEFT JOIN public.contacts             c  ON c.id  = COALESCE(g.responsable_contact_id, m.responsable_contact_id);

COMMENT ON VIEW public.v_libro_caja IS
  'Libro de caja estilo Excel: todo movimiento de una caja, con su gasto detrás si lo tiene. El saldo corrido lo calcula el front porque depende del orden y de los filtros.';

-- ════════════════════════════════════════════════════════════════════════════
-- PARTE 5 · RLS
-- ════════════════════════════════════════════════════════════════════════════
-- ⚠ PENDIENTE PRE-PRODUCCIÓN: endurecer con el resto del ERP.
ALTER TABLE public.tipos_documento_gasto ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tipos_documento_gasto_all ON public.tipos_documento_gasto;
CREATE POLICY tipos_documento_gasto_all ON public.tipos_documento_gasto FOR ALL USING (true) WITH CHECK (true);

COMMIT;
NOTIFY pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
-- ════════════════════════════════════════════════════════════════════════════
SELECT '1. TIPOS DE DOCUMENTO' AS bloque, codigo, nombre, sustento_base, color
  FROM public.tipos_documento_gasto ORDER BY orden;

SELECT '2. CATEGORÍAS CON COLOR' AS bloque, codigo, nombre, color, destino_sugerido
  FROM public.categorias_gasto ORDER BY orden;

SELECT '3. VISTA LIBRO DE CAJA' AS bloque, count(*) AS filas FROM public.v_libro_caja;

SELECT '4. TRIGGER' AS bloque, tgname, tgenabled
  FROM pg_trigger WHERE tgname = 'trg_gastos_derivar_sustento';

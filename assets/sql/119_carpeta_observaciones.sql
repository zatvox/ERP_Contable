-- ============================================================================
-- 119_carpeta_observaciones.sql  (2026-10-29)
-- Conclusiones, alertas e incongruencias de una carpeta de importación.
-- Se muestran en la hoja de costeo, DEBAJO de «Documentos de la carpeta».
--   severidad: 'ok' (registrado/cuadra) · 'info' · 'alerta' (revisar) · 'critica'
-- Aditivo e idempotente (las filas semilla de la carpeta 5 se reponen).
-- ============================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS public.carpeta_observaciones (
  id           bigserial PRIMARY KEY,
  empresa_id   bigint,
  carpeta_id   bigint NOT NULL REFERENCES public.carpetas_importacion(id) ON DELETE CASCADE,
  severidad    varchar NOT NULL DEFAULT 'info' CHECK (severidad IN ('ok','info','alerta','critica')),
  categoria    varchar,            -- Registro · Pagos · Aduanas · Costos · Documentos
  titulo       text NOT NULL,
  detalle      text,
  origen       varchar DEFAULT 'manual',   -- 'registro' (conclusión del alta) · 'manual'
  resuelta     boolean NOT NULL DEFAULT false,
  orden        integer DEFAULT 100,
  created_at   timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carpobs_carpeta ON public.carpeta_observaciones(carpeta_id);

ALTER TABLE public.carpeta_observaciones ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all" ON public.carpeta_observaciones;
CREATE POLICY "authenticated_all" ON public.carpeta_observaciones FOR ALL TO authenticated USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.carpeta_observaciones TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.carpeta_observaciones_id_seq TO authenticated;

-- ── Semilla: Carpeta 5 (id 6) · PI LXSD202523 · SPUN colores ────────────────
DELETE FROM public.carpeta_observaciones WHERE carpeta_id = 6 AND origen = 'registro';
INSERT INTO public.carpeta_observaciones (empresa_id, carpeta_id, severidad, categoria, titulo, detalle, origen, orden) VALUES
-- Conclusiones del registro
(1,6,'ok','Registro','Compra y CI','PI LXSD202523 · LANXI SHUANGDING · 34 líneas de hilado Spun 10/1, 20/1 y 30/1 en colores · 24,328.5 kg · total CI US$ 44,465.05 · compra enlazada.','registro',10),
(1,6,'ok','Registro','Embarque (B/L)','B/L YIJH60111600 (PIL) · 1×40HC PIDU4654229 · precinto CR0635311 · 993 bultos · 24,924.3 kg brutos · 68 CBM · embarque 05/03/2026 · llegada 26/04/2026 · flete prepagado US$ 1,500.','registro',20),
(1,6,'ok','Registro','DAM','DAM 118-2026-10-191474-00 · canal rojo · numerada 25/04/2026 (anticipada) · CIF US$ 46,015.05 · tributos US$ 11,540 (S/ 40,643.88, T.C. 3.522) pagados el 05/05/2026 · percepción S/ 7,006 (04/05/2026).','registro',30),
(1,6,'ok','Registro','Pagos al proveedor','Anticipo US$ 13,434.33 (28/01/2026) + saldo US$ 32,580.72 (15/04/2026) = US$ 46,015.05. Comisiones bancarias cargadas al costeo: US$ 130 (anticipo 42+12 · saldo 64+12). Registrados como históricos, sin descontar de Bancos.','registro',40),
(1,6,'ok','Registro','Liquidación del agente (Everest 2026-470)','Facturas US$ 4,462.19 + S/ 6,454.25 (16 comprobantes cargados al ledger). Abonos US$ 2,000 + S/ 1,191 y pagos directos de JHIRO US$ 443.09 + S/ 4,077.80. Saldo a favor del agente US$ 2,019.10 y S/ 1,185.45: cuadra con el documento de Everest.','registro',50),
(1,6,'ok','Registro','Ingreso, lotes y costo final','Guía EG07-00006678 (19/05/2026) vinculada a la carpeta · 34 lotes con costo real aplicado (≈ US$ 2.16/kg landed en el 20/1) · ventas pasadas recosteadas · 172 movimientos de kardex sin diferencias contra el costo del lote.','registro',60),
-- Alertas
(1,6,'critica','Aduanas','Posible doble conteo de flete y seguro en el valor en aduana','El CI suma US$ 44,465.05 y el certificado de origen declara FOB US$ 42,915.05 (diferencia = flete 1,500 + seguro 50). La DAM declara FOB 44,465.05 + flete 1,500 + seguro 50 = CIF 46,015.05, y el proveedor cobró US$ 46,015.05 en total. Si el FOB real es 42,915.05 se pagaron de más ≈ US$ 390 en tributos (ad valorem + IPM + IGV sobre US$ 1,550). Confirmar con el agente; si procede, rectificar la DAM.','registro',110),
(1,6,'alerta','Aduanas','Ad valorem liquidado (US$ 2,761) pese a TLC','El análisis de Gerencia indica que el ad valorem estaría liberado por el TLC Perú-China; la DAM lo liquida (6%) sin liberación. Revisar certificado de origen y solicitar devolución si corresponde.','registro',120),
(1,6,'alerta','Aduanas','Tributos pagados fuera de plazo','Último día de pago 26/04/2026; cancelación 05/05/2026 (9 días después). Verificar intereses o multa en la liquidación SUNAT.','registro',130),
(1,6,'alerta','Aduanas','Levante sin documento','No hay consulta de levante SUNAT de la DUA 191474 en la carpeta. Se usó 14/05/2026 (fecha del pago de almacén) como levante ESTIMADO para poder aplicar el costo. Confirmar la fecha real.','registro',140),
(1,6,'alerta','Documentos','Peso bruto distinto entre BL y DAM','BL 24,924.3 kg vs DAM 24,770 kg (154.3 kg). El peso declarado en la DAM es menor al del BL.','registro',150),
(1,6,'alerta','Documentos','Puerto de origen no coincide','PI/CI dicen «Any port of China», el BL carga en Ningbo y la DAM declara Shanghai (CNSHA).','registro',160),
(1,6,'alerta','Documentos','Nave distinta en BL y aviso de llegada','BL: «YM FOUNTAIN 183E» · aviso de llegada: «KOTA SANTOS / CKSZ0019E». Se registró la del aviso. ETA del aviso 25/04 vs llegada en la DAM 26/04.','registro',170),
(1,6,'alerta','Documentos','Incoterm: FOB en el sistema, CIF en los documentos','La PI/CI figuran FOB, pero el proveedor cobró flete y seguro y el BL indica flete prepagado. Cabecera del CI dice «FOB CALLAO». Aclarar el incoterm real con el proveedor.','registro',180),
(1,6,'alerta','Pagos','Anticipo mayor al 30% de la PI','Se pagó US$ 13,434.33 vs 30% de la PI US$ 13,339.51 (+US$ 94.82). El saldo se pagó como US$ 32,580.72, incluyendo flete y seguro.','registro',190),
(1,6,'alerta','Pagos','Sin voucher en la carpeta','Faltan los vouchers del saldo al proveedor (15/04), de los tributos y de la percepción. El saldo se cargó con comisión estimada 64+12 (el costeo gerencial indica US$ 76 en total).','registro',200),
(1,6,'alerta','Pagos','Diferencia de IGV no registrada','LC 160128: US$ 17 / S/ 59 pagados el 06/05/2026 como «otros». No existe obligación equivalente en el sistema; queda pendiente de registrar.','registro',210),
(1,6,'alerta','Costos','Gastos locales muy por encima de la cotización','Cotización Everest 2026-154: US$ 2,588.61. Real: US$ 4,462.19 + S/ 6,454.25 (≈ US$ 6,295 a 3.522), es decir +143%. Lo explican almacenaje DP World (US$ 2,918.82) y sobreestadía PIL (S/ 5,097.25, con la diferencia de S/ 1,019.45).','registro',220),
(1,6,'alerta','Costos','Late payment fee del flete','PIL cobró recargo por pago tardío del flete (US$ 50, neto US$ 35): se cargó US$ 35 como interés.','registro',230),
(1,6,'info','Costos','IGV de gastos locales','Solo las facturas de Logistic Travel Ilo traen IGV discriminado (US$ 96.13 y S/ 183.60). Las de DP World, Contrans, PIL y Transmeridian se cargaron por el importe del documento, sin separar IGV.','registro',240),
(1,6,'info','Costos','Costo del ERP vs Excel de Gerencia','Excel gerencial: landed US$ 51,882.49 (≈ US$ 2.133/kg, T.C. 3.361). ERP: costo real NIC 2 ≈ US$ 2.16/kg en el 20/1 (T.C. por línea). Diferencia por T.C. y por reparto de gastos.','registro',250),
(1,6,'info','Documentos','Fechas de las facturas de gasto aproximadas','La liquidación de Everest no trae fecha de emisión de cada factura: se usaron 28/04, 05/05 y 14/05/2026 según el abono o pago relacionado.','registro',260),
(1,6,'info','Documentos','Archivos del Drive pendientes de subir','Los PDF/Excel de la carpeta del Drive aún no se adjuntaron al ERP (la conexión al Drive solo permite leerlos). Súbelos desde «Documentos de la carpeta → Gestionar».','registro',270);

COMMIT;
NOTIFY pgrst, 'reload schema';

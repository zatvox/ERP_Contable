-- 143 · «Late payment fee flete» (PIL, US$ 35) mal clasificado como gasto financiero (2026-11-07)
-- Es un recargo de la naviera dentro de la liquidación del agente: va a Despacho (costo de inventario) y queda «Por revisar»
-- porque no se encuentra su comprobante. Costo 50 · documento 44.
update importacion_costos set concepto_codigo = 'recargo_naviera', grupo = 'despacho', clasificacion = 'inventario' where id = 50 returning id, concepto, grupo, clasificacion;
update documentos_importacion set sustentado = false where id = 44 returning id, serie, numero, sustentado;

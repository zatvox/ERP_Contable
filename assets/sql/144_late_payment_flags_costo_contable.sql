-- 144 · Late payment fee (costo 50): al pasar de Financieros a Despacho quedaron los flags del concepto anterior (2026-11-07)
-- entra_costo_contable se fija al insertar según la clasificación; ahora es 'inventario' → debe entrar al costo contable y de gestión.
-- CONSULTA previa (opcional): líneas cuyo flag contable no coincide con su clasificación
select id, concepto, grupo, clasificacion, entra_costo_contable, entra_costo_gestion from importacion_costos
where not anulado and ((clasificacion = 'inventario') <> coalesce(entra_costo_contable, false));
-- CORRECCIÓN
update importacion_costos set entra_costo_contable = true, entra_costo_gestion = true where id = 50 returning id, concepto, clasificacion, entra_costo_contable, entra_costo_gestion;

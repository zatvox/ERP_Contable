# Handoff — ERP contable ZV (JHIRO ERP)

## 1) Objetivo
ERP contable multiempresa para Perú (HTML + CSS modular + JS vanilla ES modules + Supabase), módulos Compras/Ventas/Inventario. Aún no desplegado a GitHub Pages.

## 2) Estado actual

**Funciona (implementado esta sesión):**
- Buscadores genéricos (caché + filtro en vivo) en: Compras, Guías, Ventas, Lotes.
- Orden por columna (con flecha ▲/▼) en tablas de Compras y Guías.
- Modal "Nueva Guía": selector de Compra solo muestra compras sin guía registrada aún.
- Campo "Partida" en Nueva Guía: texto libre opcional que agrupa lotes de una misma guía (`codigo_partida`), no confundir con Partidas Arancelarias (tabla `partidas`, sigue intacta).
- Columna Partida visible en tabla de Lotes (Inventario).
- Edición masiva (checkbox + aplicar Marca/Partida/Zona) en el detalle de líneas de Nueva Guía.
- Tabla de Guías: columna Producto(s)/Lote(s) resumida por producto (nombre — N lotes — cantidad total) en vez de listar cada lote.
- Filtros (buscador + categoría + stock) en tab Resumen Stock, igual que Productos.
- Kardex Valorizado: tarjetas Stock Actual/Costo Promedio/Valor Total corregidas (antes daban 0 siempre).
- `detalle_ventas.costo_unitario` corregido para líneas agregadas manualmente en Nueva Venta (antes quedaba en 0).
- Nuevo bloque **Reportes** en Inventario: tab "Stock por Partida" (agrupado por producto+partida, con buscador/categoría/filtro).

**Pendiente:**
- Verificar en vivo (navegador real) todos los cambios de esta sesión — no hubo acceso al Live Server del usuario durante la sesión.
- Ejecutar la importación masiva de Ventas (archivo `ventas.xlsx` ya generado, 112 filas listas).
- Resolver los 8 casos en `ventas_pendientes_revision.xlsx` (7 sin RUC matcheado, 1 comprobante multi-SKU sin precio por línea).
- Sumar más reportes al bloque Reportes (márgenes, valorización total, etc. — a definir con el usuario).
- Cache-busting antes de subir a GitHub Pages (pendiente eterno, recordar 4 veces más — ver memoria del proyecto).
- Auditoría RLS real + prueba end-to-end antes de producción (pendiente, recordar 4 veces más — ver memoria del proyecto).

## 3) Archivos y cambios

- `assets/js/compras.js`: fix import `getCompras` faltante (causaba ReferenceError); buscador Compras/Guías; orden por columna; filtro select Nueva Guía (solo compras sin guía); campo `codigo_partida` (texto) reemplazando el select de Partida Arancelaria en el modal de Guía; edición masiva por checkbox; overflow-x:auto en tabla de detalle; contador "N° Total de Lotes"; fix de listeners que no actualizaban totales al escribir N° Unidades / N° Lote; resumen producto/lote agrupado en tabla Guías.
- `compras.html`: inputs `buscarCompra`/`buscarGuia`; modal Nueva Guía ampliado a 1200px.
- `assets/js/ventas.js`: buscador Ventas (shell fijo + repintado de tbody, para no perder foco al escribir); nueva función `_costoPromedioItemEnZona` (reemplaza el `data-costo` roto que leía `items.costo_promedio`, columna que nunca se sincroniza).
- `assets/js/inventario.js`: buscador tab Lotes; columna Partida en Lotes; filtros en Resumen Stock; fix tarjetas Kardex (se calculan desde `lotes`, no desde `items.stock_actual`/`costo_promedio`); nuevo bloque Reportes > Stock por Partida.
- `inventario.html`: inputs de filtro en Lotes/Resumen Stock; nuevo grupo de menú "Reportes" + `tab-reportes`.
- `assets/sql/22_contacts_tipo_documento_vat.sql`: agrega `'VAT'` al CHECK de `tipo_documento` — **ya ejecutado por el usuario**.
- `assets/sql/23_codigo_partida_lotes.sql`: columna `codigo_partida` en `detalle_guias_ingreso_compra` y `lotes` — **ya ejecutado por el usuario**.
- Generados fuera del repo (carpeta de salida del usuario): `ventas.xlsx` (112 filas listas para importar, armadas desde reportes de Odoo cruzados) y `ventas_pendientes_revision.xlsx` (8 casos sin resolver).

## 4) Intentos fallidos

- **Reutilizar la tabla `partidas` (Partidas Arancelarias)** para el nuevo concepto de "código de partida" — descartado. Son conceptos distintos (aduanas vs. agrupador de lotes de una guía); se optó por una columna de texto libre nueva (`codigo_partida`) en vez de tocar el catálogo existente.
- **Verificación en vivo vía Claude in Chrome contra `localhost:5500`** — el puerto respondía "Cannot GET", no era el Live Server del proyecto. No se pudo verificar en navegador real en esta sesión; hay que hacerlo manualmente.
- **Repartir precio proporcionalmente por cantidad en comprobantes con varios productos distintos** — descartado por el usuario; se prefirió excluir esos casos del import (`ventas_pendientes_revision.xlsx`) en vez de fabricar un precio estimado.
- **Sidebar colapsado con `overflow:hidden` para ocultar texto** — rechazado por el usuario (dejaba texto cortado visible junto al ícono). Se rehizo separando ícono/label en spans independientes.

## 5) Próximos pasos

1. Abrir el ERP en el Live Server real y probar en vivo todo lo listado en "Funciona" arriba.
2. Correr el importador de Ventas con `ventas.xlsx`.
3. Revisar y resolver los 8 casos de `ventas_pendientes_revision.xlsx`.
4. Definir con el usuario qué reportes siguen sumándose al bloque Reportes.
5. Cuando el usuario lo indique: aplicar cache-busting consistente y hacer la auditoría RLS + testing end-to-end antes de desplegar a GitHub Pages.

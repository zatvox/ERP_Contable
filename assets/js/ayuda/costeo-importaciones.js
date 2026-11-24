import { E } from '../shared/ayuda.js'
const T = t => `.module-nav .tab-btn[data-tab="${t}"]`
export default [
  E('imp.cab', T('cabecera'), 'Hoja de costeo (PI y CI)', 'Datos de la carpeta de importación: proforma (PI), factura comercial (CI), productos y condiciones.', ['El **FOB** es el precio de la mercadería en origen. El sistema lo calcula; puedes corregirlo manualmente si difiere.'], { q: true }),
  E('imp.pagos', T('pagos'), 'Pagos y CxP', 'Anticipos y saldos pagados al proveedor del exterior, con sus vouchers.', null, { q: true }),
  E('imp.bl', T('billoflading'), 'Bill of Lading', 'El BL es el documento de embarque; aquí registras sus contenedores.', null, { q: true }),
  E('imp.dam', T('dam'), 'DAM', 'Declaración Aduanera de Mercancías: tributos pagados y ajustes.', null, { q: true }),
  E('imp.costos', T('costos'), 'Costos y gastos', 'Gastos locales de la importación (agente, almacén, flete…) que se suman al costo.', null, { q: true }),
  E('imp.guia', T('guia-remision'), 'Guía de remisión', 'Vincula o registra la guía con la que ingresa la mercadería al almacén.', ['Al procesarla se crean los **lotes** con su costo final.'], { q: true }),
  E('imp.resumen', T('resumen'), 'Resumen final', 'Costo total y costo unitario de la importación; puedes ver una carpeta o todas consolidadas.', ['Exporta el análisis a **Excel o PDF**.'], { q: true }),
  E('imp.e1', '.module-nav-group-toggle', 'Etapa 1: Compra y anticipo', 'Se acuerda la compra con el proveedor (proforma) y se paga el anticipo.', ['Aquí vive la **hoja de costeo** (PI y CI) y los pagos al proveedor.'], { txt: '1. Compra', q: true }),
  E('imp.e2', '.module-nav-group-toggle', 'Etapa 2: Embarque y saldo', 'La mercadería sale en barco: BL, contenedores y pago del saldo.', null, { txt: '2. Embarque', q: true }),
  E('imp.e3', '.module-nav-group-toggle', 'Etapa 3: Nacionalización', 'La carga llega a Perú: DAM, tributos, gastos locales y guía de ingreso.', null, { txt: '3. Nacionalización', q: true }),
  E('imp.e4', '.module-nav-group-toggle', 'Etapa 4: Liquidación y cierre', 'Se liquida al agente, se calcula el costo final por lote y se cierra la carpeta.', null, { txt: '4. Liquidación', q: true }),
]

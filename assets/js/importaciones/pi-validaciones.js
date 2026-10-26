// ============================================================================
// pi-validaciones.js — reglas de una Proforma (PI), compartidas por
// "Nueva OC/PI", "Completar PI" (Compras) y "Ver/Editar PI" (Importaciones).
// ============================================================================
const INCOTERMS_FLETE_INCLUIDO = ['CIF', 'CFR', 'CIP', 'CPT', 'DAP', 'DDP']
export const incotermIncluyeFlete = i => INCOTERMS_FLETE_INCLUIDO.includes(String(i || '').toUpperCase())
const num0 = x => parseFloat(x) || 0

/**
 * Obligatorios: N° de PI e incoterm. El resto puede quedar vacío (muchas PI no
 * lo traen) y se completa después. Devuelve un mensaje de error o null.
 */
export function validarCamposPI(imp, fechaOC) {
  const fuera = (x, min, max) => x != null && (x < min || x > max)
  if (fuera(imp.anticipo_porcentaje, 0, 100)) return 'El anticipo debe estar entre 0 y 100 %'
  if (fuera(imp.tolerancia_porcentaje, 0, 50)) return 'La tolerancia de cantidad debe estar entre 0 y 50 %'
  for (const [k, lbl] of [['dias_validez_anticipo', 'Plazo para pagar el anticipo'], ['dias_embarque', 'Plazo de embarque'], ['dias_saldo_desde_bl', 'Días del saldo']]) {
    const x = imp[k]
    if (x != null && (x < 0 || !Number.isInteger(x) || x > 365)) return `${lbl}: ingresa días enteros entre 0 y 365`
  }
  if (imp.validez_oferta && fechaOC && imp.validez_oferta < fechaOC) return 'La validez de la oferta no puede ser anterior a la fecha de la proforma'
  if (incotermIncluyeFlete(imp.incoterm) && (num0(imp.flete_estimado) || num0(imp.seguro_estimado)))
    return `Con ${imp.incoterm} el precio ya incluye flete y seguro: no se cargan aparte`
  return null
}

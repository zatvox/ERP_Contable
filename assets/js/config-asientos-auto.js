// ============================================================================
// CONFIG-ASIENTOS-AUTO.JS — interruptor de desarrollo para generación
// automática de asientos contables módulo por módulo.
// ============================================================================
// Mientras se sigue construyendo/probando la integración contable de cada
// módulo, este flag evita que se generen asientos reales fuera de una prueba
// controlada. Ponlo en `true` SOLO durante la prueba puntual y vuelve a
// dejarlo en `false` antes de seguir con otros módulos.
//
// No usar localStorage/config-modulo.js para esto: es un candado de
// desarrollo a nivel de código, no una preferencia de usuario que alguien
// pueda tocar desde la UI por accidente.
// ============================================================================

/** Compras domésticas (factura de compra + guía de ingreso → asiento). */
export const ASIENTOS_AUTO_COMPRAS_ACTIVO = false

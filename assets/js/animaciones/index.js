// ============================================================================
// animaciones/index.js — puerta única del módulo de animaciones
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
//
// El resto del sistema importa SIEMPRE desde acá, nunca de los archivos de
// adentro. Así, si mañana el overlay se parte en más archivos o cambia de
// nombre, no hay que tocar los 6 importadores:
//
//   import { conCarga, actualizarCarga } from '../animaciones/index.js'

export {
  mostrarCarga,
  actualizarCarga,
  tituloCarga,
  ocultarCarga,
  conCarga
} from './cargador.js'

export {
  ESTILOS_CARGA,
  ESTILO_POR_DEFECTO,
  estiloActual,
  estiloPorId,
  guardarEstilo
} from './catalogo-animaciones.js'

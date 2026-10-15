// ============================================================================
// animaciones/catalogo-animaciones.js — catálogo de estilos de carga
// Mapa completo de funciones: Claude outputs/glosario_funciones_erp.md
// ============================================================================
//
// Cada estilo es DATO, no código: un id, cómo se llama, a qué familia
// pertenece, qué decorado dibuja detrás del emblema y a qué ritmo late.
// Agregar uno nuevo es agregar una entrada acá y su bloque
// `[data-estilo="..."]` en assets/css/animaciones.css. Nada más cambia.
//
// `tempo` multiplica la velocidad que calcula el cargador: un estilo de cine
// quiere ir más lento que uno de anime aunque la carga pese lo mismo.
//
// Dos ranuras de decorado, y la diferencia importa:
//   `decorado`      va DENTRO del emblema → su centro es el centro del logo.
//                   Todo lo concéntrico (aros, ondas, órbitas, el sello).
//   `decoradoFondo` va pegado al overlay → cubre la pantalla entera. Las
//                   líneas de anime y las bandas de cine. No puede ir en el
//                   emblema: ahí heredaría su tamaño, no el de la ventana.

export const ESTILOS_CARGA = [
  {
    id: 'telar',
    nombre: 'Telar',
    familia: 'de la casa',
    descripcion: 'Carretes girando y una trama que se teje. Hilados y telas: el negocio.',
    tempo: 1,
    decorado: '<div class="carrete"></div><div class="carrete"></div><div class="trama"></div>'
  },
  {
    id: 'pulso',
    nombre: 'Pulso',
    familia: 'moderno',
    descripcion: 'Ondas concéntricas saliendo del logo. Sobrio, sirve para cualquier proceso.',
    tempo: 1,
    decorado: '<div class="onda"></div><div class="onda"></div><div class="onda"></div>'
  },
  {
    id: 'orbita',
    nombre: 'Órbita',
    familia: 'tech',
    descripcion: 'Satélites girando en anillos. Lee como "procesando varias cosas a la vez".',
    tempo: 1,
    decorado: '<div class="anillo"></div><div class="anillo"></div>'
  },
  {
    id: 'anime',
    nombre: 'Anime',
    familia: 'anime',
    descripcion: 'Líneas de velocidad y aura cargando. El clásico "juntando energía".',
    tempo: 0.8,   // va más rápido: la gracia es que se sienta eléctrico
    decorado: '<div class="aura"></div>',
    decoradoFondo:
      '<div class="velocidad">' +
      Array.from({ length: 14 }, (_, i) => {
        const izq = 4 + i * 7 + (i % 3) * 2
        const retraso = ((i * 37) % 100) / 100
        return `<i style="left:${izq}%; animation-delay:${retraso}s"></i>`
      }).join('') +
      '</div>'
  },
  {
    id: 'cine',
    nombre: 'Cine',
    familia: 'película',
    descripcion: 'Barras letterbox, grano de película y un zoom lento. Para procesos largos.',
    tempo: 1.35,  // más lento a propósito: el cine respira
    decorado: '',
    decoradoFondo: '<div class="banda arriba"></div><div class="banda abajo"></div><div class="grano"></div>'
  },
  {
    id: 'rustico',
    nombre: 'Rústico',
    familia: 'rústico',
    descripcion: 'Papel kraft, sepia y un sello de goma que cae. Para cargas retroactivas y cierres.',
    tempo: 1.2,
    decorado: '<div class="sello"></div>'
  }
]

export const ESTILO_POR_DEFECTO = 'telar'

const CLAVE_LS = 'erp_estilo_carga'

/** Estilo elegido por el usuario (se guarda en este navegador). */
export function estiloActual() {
  try {
    const id = localStorage.getItem(CLAVE_LS)
    if (id && ESTILOS_CARGA.some(e => e.id === id)) return id
  } catch (_) { /* navegador sin localStorage: se usa el de por defecto */ }
  return ESTILO_POR_DEFECTO
}

export function guardarEstilo(id) {
  if (!ESTILOS_CARGA.some(e => e.id === id)) return false
  try { localStorage.setItem(CLAVE_LS, id) } catch (_) { /* no es crítico */ }
  return true
}

export function estiloPorId(id) {
  return ESTILOS_CARGA.find(e => e.id === id) || ESTILOS_CARGA.find(e => e.id === ESTILO_POR_DEFECTO)
}

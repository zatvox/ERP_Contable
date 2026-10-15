# assets/js/animaciones/

Catálogo de animaciones del ERP. Agrupado por característica, igual que
`compras/`, `ventas/` e `inventario/`.

| Archivo | Qué hace |
|---|---|
| `index.js` | Puerta única. **Todo el resto del sistema importa desde acá.** |
| `cargador.js` | El overlay: mostrar, avanzar, ocultar, y el modal del catálogo. |
| `catalogo-animaciones.js` | Los estilos, como dato puro. |
| `../../css/animaciones.css` | Los keyframes. Lo inyecta `cargador.js`; ninguna página HTML lo referencia. |

## Cómo se usa

```js
import { conCarga, actualizarCarga } from '../animaciones/index.js'

await conCarga({ titulo: 'Importando compras', subtitulo: '47 documentos · BENJI', total: 47 }, async () => {
  for (const doc of documentos) {
    await grabar(doc)
    actualizarCarga()            // suma 1; también acepta el absoluto
  }
})
```

`conCarga` oculta el overlay aunque la función tire error. Si se usa suelto
(`mostrarCarga` / `ocultarCarga`), el `ocultarCarga()` va **siempre en un
`finally`**: si no, un error deja la pantalla tapada y el usuario cree que se
colgó.

Sin `total`, el aro gira como spinner clásico. Con `total`, el aro se llena de
verdad y abajo aparece *"16 de 47 · faltan ~38 s"*, con el tiempo estimado a
partir del ritmo **medido**, no de un número inventado.

## La velocidad se calcula

`_velocidad(total, tempo)` en `cargador.js`:

```
base = 0.75 s + min(total, 600) / 360      →  0.75 s … 2.42 s por ciclo
velocidad = base × tempo-del-estilo
```

20 documentos laten ágil; 500 laten calmo. Un parpadeo nervioso durante un
minuto cansa, y una animación lenta en medio segundo se ve trabada. El `tempo`
de cada estilo ajusta encima: *Cine* respira más lento (1.35) y *Anime* va más
rápido (0.8) aunque el archivo sea el mismo.

## Estilos

| id | Familia | Idea |
|---|---|---|
| `telar` | de la casa | Carretes girando y una trama tejiéndose. **Por defecto.** |
| `pulso` | moderno | Ondas concéntricas saliendo del logo. |
| `orbita` | tech | Satélites en anillos: "procesando en paralelo". |
| `anime` | anime | Líneas de velocidad y aura cargando. |
| `cine` | película | Letterbox, grano y zoom lento. Para procesos largos. |
| `rustico` | rústico | Papel kraft, sepia y sello de goma. Para cargas retroactivas. |

El usuario elige el suyo en **Configuración → Animación de carga**
(`window.abrirCatalogoAnimaciones()`); se guarda en `localStorage` de ese
navegador, no en la BD — es una preferencia visual, no un dato del negocio.

## Las dos ranuras de decorado

Un estilo puede dibujar en dos capas, y la diferencia no es cosmética:

| Ranura | Dónde se monta | Para qué |
|---|---|---|
| `decorado` | **dentro de `.carga-emblema`** | Su `50% 50%` es el centro del logo. Todo lo concéntrico: aros, ondas, órbitas, el sello. |
| `decoradoFondo` | en `.carga-telon`, pegado al overlay | Cubre la ventana entera. Las líneas de anime, las bandas de cine. |

Las dos trampas que esto evita, ambas vistas en vivo:

1. Colgado de `.carga-escena`, el centro del decorado caía **entre el logo y el
   bloque de texto**: los aros se veían corridos hacia abajo respecto del aro de
   progreso. Por eso el decorado concéntrico vive dentro del emblema.
2. `.carga-escena` se anima con `transform`, y **un transform crea bloque
   contenedor**: un `position: fixed` adentro se queda del tamaño de la escena en
   vez de cubrir la ventana. Por eso lo de pantalla completa cuelga del overlay,
   que no tiene transform.

Si un aro nuevo sale descuadrado, casi siempre es que quedó en la ranura equivocada.

## Agregar un estilo

1. Una entrada en `ESTILOS_CARGA` (`catalogo-animaciones.js`) con su `decorado`
   y/o su `decoradoFondo`.
2. Su bloque `[data-estilo="tu-id"]` en `animaciones.css`.

Nada más cambia: el selector, la vista previa y los 6 importadores lo toman solos.

Ojo con el tamaño del aro más grande: el emblema mide 132 px y la escena deja
46 px de aire hasta el título. Un aro de más de ~180 px se le monta encima.

## Identidad

El color y el logo salen de la **empresa de trabajo** (`empresa_config.color`,
`logo_url`; si no hay logo, el monograma del código). Mismo criterio que el riel
de los modales: saber en qué empresa estás sin tener que leer nada. El import de
`empresa.js` es dinámico a propósito — si el contexto de empresa aún no resolvió,
el overlay igual funciona, en gris.

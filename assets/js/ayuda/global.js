import { E } from '../shared/ayuda.js'
export default [
  E('g.campanita', '#btnCampanita', 'La campanita de avisos', 'Aquí llegan tus avisos: tareas que te asignaron, vencidas, recordatorios de despacho y alertas del sistema.',
    ['Cada aviso es un enlace: al hacer clic te lleva al lugar donde debes actuar.', '• **Avisos**: se guardan hasta que los marques como leídos.', '• **Recordatorios**: desaparecen solos cuando resuelves el tema (por ejemplo, al emitir la guía pendiente).', '• **Tareas**: si alguien te espera, aparece primero.'], { q: true }),
  E('g.tema', '#themeToggle', 'Modo claro / oscuro', 'Cambia los colores de toda la pantalla. Se recuerda en este equipo.'),
  E('g.empresa', '.header-controls [id*="empresa" i], .empresa-chip, #empresaChip', 'Selector de empresa', 'Elige con qué empresa trabajas. Los datos que ves y los documentos que creas dependen de esta selección.',
    ['• Puedes activar **varias empresas** para ver datos combinados (solo lectura combinada en reportes).', '• La **empresa de trabajo** (con la estrella/punto) es la que se usa al crear documentos nuevos.', 'Al cambiar de empresa la pantalla se recarga.'], { q: true }),
  E('g.menu', '.sidebar-menu a[data-page="tareas"]', 'Tareas', 'Lo que debes hacer y lo que otros te piden, con fechas y responsables.', null),
]

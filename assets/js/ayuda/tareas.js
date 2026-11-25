import { E } from '../shared/ayuda.js'
export default [
  E('tar.mias', '.tk-tab[data-v="mias"]', 'Mis tareas', 'Las tareas que te asignaron a ti, ordenadas por urgencia.',
    ['Las vencidas aparecen primero con una barra roja y los días de atraso. Las nuevas llevan la etiqueta **Nueva** hasta que las abres.', '## ¿Qué hago con una tarea?', '• **Empezar**: pasa a «En proceso».', '• **Marcar hecha**: la cierra.', '• **Estoy esperando a…**: úsalo cuando algo te frena (ver ayuda de «Bloqueada»).'], { q: true }),
  E('tar.pedidas', '.tk-tab[data-v="pedidas"]', 'Las que pedí', 'Tareas que tú creaste para otras personas. Aquí ves cómo avanzan.',
    ['Puedes reasignarlas, editarlas o anularlas mientras estén abiertas. Si una está **bloqueada**, verás a quién espera y desde cuándo, sin necesidad de preguntar.'], { q: true }),
  E('tar.gerencia', '.tk-tab[data-v="gerencia"]', 'Gerencia', 'Vista de todo lo abierto: el administrador ve todo; el jefe de área, lo de su área.',
    ['Arriba verás cuatro números: pendientes, vencidas, bloqueadas y cerradas esta semana.', 'Aquí se detectan cuellos de botella: una tarea **bloqueada** muestra de quién depende y cuántos días lleva detenida.', '## ¿Quién es jefe de área?', 'Se marca en RRHH → Empleados → Contrato → casilla «Jefe de área», junto al área de la persona.'], { q: true }),
  E('tar.nueva', '#tk-btn-nueva', 'Crear una tarea', 'Pide algo a alguien con fecha límite. Queda registrado quién lo pidió y cuándo.',
    ['• Si eliges responsable, la tarea hereda su **área** automáticamente.', '• Puedes asignarla a alguien **sin cuenta** en el sistema: la verá su jefe o gerencia.', '• Quien no tiene relación con la tarea no puede verla.']),
  E('tar.rec', '#tk-btn-rec', 'Tareas recurrentes', 'Tareas que se crean solas cada día, semana, quincena o mes (cierres, arqueos, declaraciones).',
    ['La fecha límite se calcula sola. En mensual, si eliges día 31 y el mes tiene menos días, se usa el **último día del mes**.', 'Se generan al abrir este módulo; no se duplican aunque lo abras muchas veces. Puedes **pausar** una recurrente cuando no aplique.']),
  E('tar.buscar', '#tk-buscar', 'Buscar tareas', 'Escribe parte del título, del nombre de la persona o del área.', null, {}),
  E('tar.abiertas', '#tk-abiertas', 'Solo abiertas', 'Oculta las tareas hechas y anuladas. Desmárcalo para ver el historial reciente.', null),
]

# RUNBOOK.md — Guía operativa para IA

> **Léeme primero.** Este documento permite a cualquier IA entender la aplicación RAICE
> y resolver problemas de forma **rápida y segura**. Si solo vas a leer un archivo, lee este.
>
> Documentos relacionados: `AGENTS.md` (reglas de migración), `public/shared/README.md`
> (capa compartida), `CHECKLIST.md` (validación), `DESPLIEGUE.md` (instalación).

---

## 1. Qué es RAICE (en 30 segundos)

Plataforma escolar colombiana (Ley 1620 — convivencia escolar) para gestionar asistencia,
casos de convivencia, observador del estudiante, excusas y reportes. Tiene **5 roles**:
superadmin, coordinador (admin), docente (teacher), rector, y portal de acudientes (público).

**Stack:**
- Frontend: **HTML monolítico** (1 archivo por rol) con JS vanilla inline. Sin framework, sin build.
- Backend: **un solo archivo** `pages/api/[...path].js` (Next.js API route) con TODA la lógica.
- Base de datos: **Supabase** (PostgreSQL). Acceso vía service_role key.
- Hosting: **Vercel** (auto-deploy desde GitHub).
- Auth: JWT propio (no Supabase Auth). Token en `sessionStorage`.

---

## 2. Mapa de archivos

```
pages/api/[...path].js        ← TODO el backend (~9000 líneas). Router por `route` string.
public/
  login.html                  Login (todos los roles)
  superadmin.html             Panel superadmin
  admin.html                  Panel coordinador (el más grande, ~10k líneas)
  docente.html                Portal docente
  rector.html                 Panel rector
  portal-acudiente.html       Portal padres (público, sin token)
  shared/                     ← Capa compartida (ver public/shared/README.md)
    constants/index.js        Constantes (días, etiquetas, colores)
    utils/index.js            Utilidades (escapeHtml, logout, showToast, checkAuth...)
    utils/printObservador.js  Impresión del observador
    utils/pwa.js              Banners PWA
    data/apiClient.js         createApiClient() — cliente HTTP
    data/realtime.js          initRealtime() — Supabase Realtime
    data/repositories.js      Funciones de acceso a datos (fetchX, createX...)
    domain/index.js           Reglas de negocio (gradeLbl, classifyRisk...)
RAICE_maestro.sql             Esquema completo de la BD (fuente de verdad de tablas/constraints)
vercel.json                   Config Vercel + cron jobs
```

### Patrón shared (CRÍTICO — no romper)
Los módulos `shared/` son **IIFE** que registran en `window.RAICE`. Se cargan como
`<script src>` **regulares** (NUNCA `type="module"` — rompe el timing con PWA/Realtime).
Los HTML hacen `var { x } = window.RAICE;` al inicio. Detalle completo en `public/shared/README.md`.

---

## 3. Cómo desplegar (LEE ESTO ANTES DE EDITAR)

⚠️ **La fuente de verdad es GitHub, no las carpetas locales.** El repositorio Git conectado
a Vercel es:
- Remoto: `https://github.com/camilopmapp/raice.git` (rama `main`)
- Clon local de trabajo: **`RAICE FINAL/`** (es el único con `.git` apuntando a ese remoto)

**Flujo correcto — trabajar DIRECTO en el clon Git y pushear:**
```bash
# 1. Editar archivos en RAICE FINAL/
# 2. Validar sintaxis (ver abajo)
# 3. Commit + push:
git add <archivos>
git commit -m "..."
git push origin main
# 4. Vercel detecta el push y despliega solo (~1-2 min).
```

⚠️ **Flujo OBSOLETO (ya NO se usa):** antes se editaba en `RAICE MIGRACION/`, se copiaba a
`RAICE 060626/` y se subía por la **web de GitHub** ("Add files via upload"). Eso provocó que
el clon local llegara a estar **264 commits ATRÁS** del remoto. **Esas carpetas pueden estar
desactualizadas — no las uses como referencia.**

⚠️ **SIEMPRE sincroniza el clon antes de tocar nada** (por si alguien subió por la web):
```bash
git fetch origin
git rev-list --left-right --count main...origin/main   # izq=local adelante, der=remoto adelante
git merge --ff-only origin/main                         # si el local está solo atrás (sin divergencia)
```
**Si pusheas desde un clon viejo, sobrescribes el trabajo que esté en el remoto.**

⚠️ `pages/api/[...path].js` tiene **corchetes** en el nombre. En Bash basta con comillas;
en PowerShell usa `-LiteralPath` (los corchetes son glob).

**El cambio NO está en producción hasta que el push llega a GitHub y Vercel termina el build.**

### Verificar sintaxis antes de pushear
```bash
node --check "pages/api/[...path].js"        # API (Bash maneja los corchetes con comillas)
```
Para un HTML, validar los bloques `<script>` inline (regex extrae los `<script>` sin `src` y
`new vm.Script(...)` por bloque). NUNCA pushear sin que compile.

---

## 4. Esquema de BD — lo que SIEMPRE debes verificar

La fuente de verdad es `RAICE_maestro.sql`. **29 tablas** con prefijo `raice_`.
Antes de tocar inserciones/restauración, revisa los **constraints** de la tabla afectada.

### Constraints que causan el 90% de los bugs de datos

| Tabla | Constraint clave | Trampa común |
|---|---|---|
| `raice_attendance` | `UNIQUE(student_id, date, course_id, class_hour)` · `course_id` NOT NULL · `status IN (P,A,PE,T,S,NR)` | FK a course/teacher que no existe → registro se pierde |
| `raice_students` | `status IN (active,transferred,retired,graduated,desertor)` · `code` UNIQUE | status 'inactive' u otro → viola CHECK |
| `raice_subgroup_members` | UNIQUE(subgroup_course_id, student_id) + posible UNIQUE(student_id) | un estudiante en 2 subgrupos falla |
| `raice_periods` | `UNIQUE(year, period_num)` · `year` NOT NULL | period_num huérfano al reducir num_periods |
| `raice_calendar` | `type IN (holiday,vacation,event,institutional_day)` | type fuera de lista → viola CHECK |
| `raice_observations` | `type IN (positive,neutral,negative)` · teacher/course nullable | FK inválido |
| `raice_cases` | `type IN (1,2,3)` · `status IN (open,tracking,closed)` · teacher_id FK | teacher_id inexistente |
| `raice_faltas_catalogo` | `UNIQUE(tipo, categoria, numeral)` | upsert por id falla por el otro unique |
| `raice_suspensions` | tiene `coordinator_id` (NO teacher_id) | columna inexistente al mapear |

### Regla de oro al insertar datos de otra fuente (backup, import)
Antes de insertar, **limpiar las FK**:
- FK NOT NULL inválido → **descartar** el registro (no se puede insertar).
- FK nullable inválido → ponerlo en **null** (preserva el registro).
- Campo con CHECK → **mapear** a un valor válido o un default.
- Validar contra IDs **reales en BD** (consultar `select id`), no contra los del archivo.

---

## 5. Problemas conocidos y solución probada

### 5.1 La restauración de backup pierde datos (asistencia, etc.)
**Causa:** registros con FK a docente/curso inexistente se descartan; o payload > 4.5MB
(límite de Vercel) en un solo POST.
**Solución implementada:** en `handleBackupImport` (step 'chunk'), la asistencia/observaciones
se importan en lotes de 500 desde el frontend, y en el servidor se limpian las FK
(course_id obligatorio se valida; teacher_id/corrected_by inválidos → null) y el status se
mapea contra el CHECK. Si faltan datos tras restaurar, revisa `errors[]` que devuelve el endpoint.

### 5.2 El conteo de períodos muestra de más (ej: 4 cuando son 3)
**Causa:** período huérfano `period_num > num_periods` que quedó al reducir el número de
períodos (el dropdown de config y "Guardar períodos" son guardados distintos).
**Solución:** `handleConfig` borra `raice_periods` con `period_num > num_periods` al guardar.
El usuario re-guarda la configuración para limpiar. La app ya filtra `period_num <= num_periods`.

### 5.3 Una vista deja de funcionar tras tocar shared (onclick no responde, "X is not a function")
**Causa típica:** se usó `type="module"` (defer rompe timing), o falta cargar
`shared/utils/index.js` (donde viven checkAuth, showToast, logout), o `checkAuth` retornó null.
**Solución:** usar `<script src>` regular; cargar TODOS los módulos shared que el HTML use;
`checkAuth` retorna `{}` (no null) cuando hay token válido pero sin datos de user.

### 5.4b ⚠️ Una vista (asistencia, lista, reporte) muestra datos truncados / faltan fechas recientes
**Causa REAL y más común:** Supabase/PostgREST **limita por defecto a 1000 filas** por consulta.
Cualquier query de `raice_attendance` (u otra tabla grande) sobre un rango de fechas o muchos
cursos puede superar 1000 filas y **cortar el resto** (las fechas más recientes si ordena por fecha ASC).
NO es problema de restore ni de datos faltantes — los datos SÍ están en la BD.
**Síntoma clásico:** un curso con >1000 registros de asistencia muestra solo las primeras fechas.
**Solución:** PAGINAR la consulta con `.range(offset, offset+999)` en un loop hasta traer todo.
Ya aplicado en `getAttendanceRange` (docente) y en el rango/lista del coordinador (`handleAttendance`).
**Si aparece en reportes/stats:** buscar `.from('raice_attendance').select(...)` sin paginación
y aplicar el mismo patrón. **LECCIÓN:** antes de culpar al restore/datos, verifica si el query
puede devolver >1000 filas. Compara: si el backup tiene el dato (revísalo con un script Node leyendo
el .json) pero la vista no lo muestra, casi siempre es el límite de 1000, no los datos.

### 5.4 El historial de asistencia del DOCENTE muestra menos fechas/registros que el real
**Causa:** `getAttendanceRange` filtra la asistencia del docente por su HORARIO
(`raice_schedules` por `teacher_course_id`). Si el horario quedó incompleto tras un restore,
descarta registros de asistencia que SÍ existen. El restore perdía horarios porque
`raice_teacher_courses` requiere `course_id` válido (NOT NULL) pero solo se validaba `teacher_id`;
los tc que fallaban dejaban sus `raice_schedules` huérfanos (FK en cascada). Síntoma: el backup
preview muestra "Horarios clase: 650" pero el restore importa solo ~50.
**Solución:** validar teacher_courses por teacher_id Y course_id reales en BD; validar schedules
contra los teacher_course_id que REALMENTE quedaron en BD (query `select id`), no contra el filtro;
deduplicar por (teacher_course_id, day_of_week, class_hour). **Diagnóstico:** comparar la misma
vista en COORDINADOR (no filtra por horario) vs DOCENTE — si difieren, es el horario.

### 5.5 Superadmin no carga datos
**Causa:** faltaba `<script src="/shared/utils/index.js">` en el `<head>` (checkAuth no existía).
**Solución:** confirmar que cada HTML carga los módulos shared que referencia.

### 5.6 Excusas/permisos — "el permiso MANDA" (debe reflejarse en TODOS los módulos)
Un permiso/excusa debe dejar al estudiante en `PE`, sin importar el orden de los eventos
(excusa antes o después de tomar lista). Hay **CUATRO** puntos que deben respetarlo (ya
implementados); si un permiso "no se ve" en algún lado, revisa el que falle:
- **Registrar excusa** (`handleExcusas` POST): convierte cualquier estado previo
  (A, P, T, S, NR) → PE en las horas cubiertas (`.neq('status','PE')`).
- **Guardar lista** (`handleAttendance` POST): antes de insertar consulta las excusas de la
  fecha y fuerza `status='PE'` a quien tenga excusa que cubra la hora (si no, el guardado
  borraba el PE e insertaba Presente).
- **Vista del docente** (`handleAttendance` GET): muestra PE si hay excusa que cubre la hora,
  aunque el registro guardado diga otra cosa.
- **Portal del acudiente** (`handlePortalAcudiente`): reconcilia asistencia con excusas ANTES
  de calcular conteo de ausencias, %, calendario y asistencia por asignatura.
Cobertura: `horas` null/vacío = toda la jornada; si trae horas, debe incluir la hora.
Estas son reconciliaciones en LECTURA/escritura puntual; no reescriben registros históricos en masa.

### 5.7 "Corregir lista" del docente se cierra sola / no entra a corrección
**Causa:** desbloquear solo cambia estado LOCAL, pero el auto-refresco (60s) y el Realtime
recargan la hora y el servidor sigue reportando `saved=true` (desbloquear NO borra registros)
→ re-bloquea. Solo los frenaba `_attDirty`, que es false hasta editar algo.
**Solución:** bandera `_correctionMode` (clave `curso_fecha_hora`) que el auto-refresco y el
Realtime respetan; se limpia al cambiar curso/hora/fecha y al guardar. En `docente.html`.

### 5.8 Mapa escolar muestra "undefined" / "No hay cursos con horario cargado"
**Causa:** `fetchSchedulesOverview` (`shared/data/repositories.js`) descartaba `today_dow` del
backend → `DAYS[undefined]` y el filtro `day_of_week === undefined` no casa con ningún horario.
**Regresión de la migración** (el wrapper recortó campos del JSON).
**Solución:** reenviar `today` y `today_dow` en el wrapper. **LECCIÓN:** los wrappers de
`repositories.js` deben devolver TODOS los campos que la vista usa. Si una vista migrada muestra
"undefined" o vacío, sospecha del wrapper recortando la respuesta del backend.

### 5.9 El Realtime del admin no refresca nada
**Causa:** los callbacks comparaban `currentSection === 'sec-asistencia'` (con prefijo `sec-`),
pero `currentSection` guarda el nombre CORTO (`'asistencia'`, `'casos'`, `'dashboard'`…). Nunca
casaba. (`currentSection = name`; el DOM id es `'sec-' + name`.)
**Solución:** comparar sin el prefijo `sec-`. El Mapa escolar "Ahora mismo" además se refresca
en vivo al registrar asistencia, con debounce (~800ms) porque una clase = muchos inserts.

### 5.10 Festivos: las vistas deben respetar el día no lectivo
El backend `/raice/calendar/today` devuelve `blocks_attendance` y `event`. Las vistas de "ahora"/
"hoy" deben consultarlo y NO pintar clases como en curso:
- Docente "Mi horario" → aviso de festivo en "Hoy tengo".
- Docente "Historial de asistencia" → NO depende de `loadMyCourses()` (se cancela en festivo);
  carga cursos directo con `fetchMyCourses`.
- Mapa escolar → "Ahora mismo" muestra aviso; "Por grupo/Por docente" banner + columna de hoy
  neutralizada (sin badges de pendiente).

### 5.11 Portal acudiente: el detalle de asistencia no mostraba materia ni docente
**Causa:** la consulta de asistencia del portal no seleccionaba `course_id`, así que el bloque
que cruza cada hora con el horario (curso+día+hora → materia/docente) no corría.
**Solución:** agregar `course_id` al `select`. El frontend ya sabía mostrar `subject`/`teacher_name`.

### 5.12 Ficha del estudiante (admin/rector) y portal del acudiente deben coincidir
El resumen del estudiante que ve el **coordinador** y el **rector** (buscador global → ficha) y el
**portal del acudiente** salen de **una sola función backend**: `buildAttendanceInsights(sb,
studentId, courseId, attData)`. Reconcilia excusas (el permiso MANDA), enriquece materia/docente,
calcula asistencia por asignatura, director y el resumen canónico. **Si agregas datos al resumen,
hazlo en ese helper** para que las tres vistas no diverjan. Endpoints: `/raice/student-ficha`
(admin/rector, por id) y `/raice/portal-acudiente` (público, por documento).

---

## 5B. ⭐ CRITERIO ÚNICO de % de asistencia (NO reintroducir otra fórmula)

> Históricamente había **15+ cálculos de % con 4 fórmulas distintas** → el mismo estudiante daba
> % diferente según la pantalla. Se unificó. **No vuelvas a inventar una fórmula local.**

**Fórmula canónica (única):**
```
countable = total − S − PE
pct       = (P + T) / countable        // null si countable ≤ 0
```
- **T (tardanza) CUENTA como asistencia** (suma en el numerador).
- **PE (permiso) y S (especial / sin lista) se EXCLUYEN del denominador** (no bajan ni suben el %).
- **A (ausente) y NR** quedan en el denominador → bajan el %.

**Helper único** (en `pages/api/[...path].js`, junto a `dayOfWeekCO`):
- `attendanceStats(records)` → `{ total, present, absent, late, permit, special, countable, pct }`
  a partir de un arreglo de registros `{status}`.
- `_pctCanonical(P, T, PE, S, total)` → solo el número, cuando ya tienes los conteos agregados.

**Regla:** cualquier cálculo nuevo de % de asistencia DEBE usar uno de esos dos. NO escribas
`present / total`, ni cuentes PE como presente, ni omitas excluir S.

**Única excepción legítima:** el **% por hora** del Mapa escolar (`pctByHour` con `hasRealList`)
responde otra pregunta — *"qué % de estudiantes asistió en ESA hora"* — y usa su propio modelo.
Eso NO es el % de un estudiante y NO se unifica.

**Si reportan que dos pantallas muestran % distinto del mismo estudiante:** alguien metió una
fórmula local. Búscala (`grep "/ total\|present /\|/ countable"`) y reemplázala por el helper.

---

## 6. Metodología de diagnóstico (¿código o datos?)

Antes de "arreglar código", determina la naturaleza del problema:

1. **¿El código que renderiza cambió recientemente?** Si NO se tocó la función de display
   y aun así muestra distinto → es problema de **DATOS**, no de código. Revisa la BD/restore.
2. **¿El mismo query devuelve distinto?** Entonces la BD cambió (restore parcial, FK drops).
3. **¿Hay error en consola del navegador (F12)?** Errores rojos = problema de JS frontend.
   `X is not a function` = módulo shared no cargado o `type="module"`.
4. **¿500 en la API?** Revisa logs de Vercel (Functions). Suele ser FK, CHECK, o auth.
5. **Reproduce con un caso mínimo** antes de cambiar nada.

---

## 7. Reglas de seguridad (NO romper)

- **Cero regresión funcional** (AGENTS.md §2). Si un cambio toca flujos no relacionados, rediseñar.
- **Nunca** exponer `SUPABASE_SERVICE_ROLE_KEY` ni `JWT_SECRET` en el frontend.
- **Validar siempre** con `node --check` antes de copiar a producción.
- **Cambios acotados y reversibles.** Identifica el commit de rollback antes de tocar.
- **No big-bang.** Migración incremental (strangler pattern).
- Ejecutar el **CHECKLIST.md** del rol afectado antes de dar por terminado.
- El SQL es idempotente (`IF NOT EXISTS`); para cambios de constraint, sección
  "CORRECCIONES DE CONSTRAINTS" del SQL.

---

## 8. Estado de la migración (contexto)

Arquitectura migrando de monolito a capas (AGENTS.md §10). **Sigue siendo MAYORMENTE
monolítica** — la migración solo extrajo la capa compartida:

- **Backend:** `pages/api/[...path].js` ≈ **9.000 líneas en UN solo archivo** (100% monolito,
  router por string `route`). Es el punto más frágil: cualquier cambio toca un archivo enorme
  compartido por todos los roles.
- **Frontend:** 1 HTML gigante por rol con JS inline — admin ≈10.4k, superadmin ≈6.4k,
  docente ≈4.8k, rector ≈1.7k, portal ≈0.7k líneas.
- **Modularizado (lo migrado):** `public/shared/` = 8 archivos, **≈876 líneas** (constants,
  utils, data: apiClient + repositories + realtime, domain).

Etapas 1-4 (capa compartida) completas. Etapa 5 (presentation) y el **troceado del backend**
pendientes — hacer **incremental**, NO big-bang. Candidato natural siguiente: partir el backend
por dominio (asistencia, casos, excusas, estudiantes…).

---

## 9. Checklist rápido para resolver un problema nuevo

1. [ ] Leer este RUNBOOK + el doc específico (shared/README, AGENTS, etc.)
2. [ ] Reproducir el problema; mirar consola (F12) y/o logs de Vercel
3. [ ] Determinar si es código o datos (sección 6)
4. [ ] Revisar constraints de la tabla afectada en `RAICE_maestro.sql` (sección 4)
5. [ ] Hacer el cambio MÍNIMO y acotado
6. [ ] `node --check` del archivo (y validar `<script>` inline si es HTML)
7. [ ] `git add` + `commit` + `push origin main` desde `RAICE FINAL/`
8. [ ] Ejecutar CHECKLIST.md del rol afectado
9. [ ] Confirmar al usuario el commit pusheado y que Vercel desplegó

---

*RUNBOOK v3 — junio 2026. Cambios v3: criterio ÚNICO de % de asistencia (sección 5B) y helper
compartido `buildAttendanceInsights` (5.12) — ficha admin/rector y portal del acudiente usan la
misma lógica y la misma fórmula canónica. Cambios v2: flujo de despliegue por Git directo en
`RAICE FINAL` (deja de usar las 2 carpetas / subida por web); problemas 5.6–5.11 (permiso manda,
corregir lista, mapa escolar today_dow, realtime sec-, festivos, portal materia/docente); estado
real de la migración. Mantener actualizado al resolver problemas nuevos (sección 5).*

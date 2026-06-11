# Checklist de validación — RAICE

Smoke test a ejecutar **antes de cada despliegue** que toque archivos del frontend o `pages/api/`.
Cumple AGENTS.md §6 (checklist mínimo por cambio) y §8 (pruebas y verificación).

## Cómo usar
1. Abrir cada vista con un usuario real del rol.
2. Abrir la consola del navegador (F12 → Consola) — **no debe haber errores en rojo**.
3. Marcar cada flujo. Si algo falla, NO desplegar hasta corregir.

---

## Por cada cambio (mínimo — AGENTS.md §6)
- [ ] Alcance definido y acotado
- [ ] Impacto colateral evaluado
- [ ] Smoke test de los roles afectados ejecutado
- [ ] Plan de rollback listo (commit anterior identificado)
- [ ] Documentación actualizada si cambió la arquitectura

---

## Rector (`/rector.html`)
- [ ] Consola sin errores al cargar
- [ ] Dashboard: stats, donut de asistencia y gráfico por grado cargan
- [ ] Buscar estudiante por nombre → abrir ficha
- [ ] Ficha: pestañas Resumen / Asistencia / Casos / Observaciones
- [ ] Botón "Imprimir observador" genera la ventana
- [ ] "Ahora mismo" muestra la hora de clase actual
- [ ] Horarios: por grado y por docente
- [ ] Cambiar contraseña (Mi perfil)
- [ ] Cerrar sesión

## Coordinador / Admin (`/admin.html`)
- [ ] Consola sin errores al cargar
- [ ] Dashboard: KPIs + alertas + asistencia hoy
- [ ] Navegación entre todas las secciones del sidebar
- [ ] Estudiantes: listar, filtrar, ver asistencia del mes
- [ ] Crear un caso RAICE
- [ ] Casos: listar y abrir detalle
- [ ] Asistencia general: cargar por fecha
- [ ] Observador digital
- [ ] Períodos académicos cargan
- [ ] Mapa escolar: horarios cargan
- [ ] Cambiar contraseña
- [ ] Cerrar sesión

## Docente (`/docente.html`)
- [ ] Consola sin errores al cargar
- [ ] Mis cursos cargan
- [ ] Pasar lista: marcar y guardar asistencia
- [ ] Verificar que la asistencia guardada persiste al recargar
- [ ] Registrar observación a un estudiante
- [ ] Reportar caso
- [ ] Mi horario semanal
- [ ] Historial de asistencia carga registros
- [ ] Imprimir observador
- [ ] Cambiar contraseña

## Superadmin (`/superadmin.html`)
- [ ] Consola sin errores al cargar
- [ ] Dashboard carga
- [ ] Usuarios: crear / editar / eliminar
- [ ] Cursos y sedes: CRUD
- [ ] Grados y cursos
- [ ] Configuración del colegio (guardar)
- [ ] Horario de timbres (bell schedule)
- [ ] Catálogo de faltas
- [ ] **Restaurar backup** → verificar que el resumen muestre asistencia > 0
- [ ] Después del backup: confirmar que estudiantes, casos, asistencia y subgrupos aparecen

## Portal Acudiente (`/portal-acudiente.html`)
- [ ] Consultar por número de documento
- [ ] Pestañas Asistencia / Casos / Compromisos / Observador / Disciplina / Datos
- [ ] Calendario de asistencia muestra colores correctos

---

## Verificación técnica rápida (opcional, vía consola del navegador)
```js
// Confirmar que todos los módulos shared cargaron:
Object.keys(window.RAICE).length  // debe ser > 70
typeof window.RAICE.checkAuth     // "function"
typeof window.RAICE.fetchStudents // "function"
```

## Integración (AGENTS.md §8)
- [ ] Supabase Realtime: al cambiar un dato en una pestaña, otra pestaña del mismo rol se actualiza
- [ ] Despliegue estable en Vercel (build sin errores)

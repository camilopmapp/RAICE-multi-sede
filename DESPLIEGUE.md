# 🚀 Guía de instalación RAICE — desde cero

> RAICE — Ruta de Atención Integral para la Convivencia Escolar
> Basado en la Ley 1620 de 2013 · MinEducación Colombia

---

## Requisitos previos

- Cuenta en [Supabase](https://supabase.com) (gratuita)
- Cuenta en [Vercel](https://vercel.com) (gratuita)
- Cuenta en [GitHub](https://github.com) (gratuita)

---

## Paso 1 — Obtener el código

### Opción A: Descargar como ZIP
1. Ve al repositorio en GitHub
2. Clic en **Code → Download ZIP**
3. Descomprime en tu computador

### Opción B: Clonar con git
```bash
git clone https://github.com/TU_USUARIO/raice.git
cd raice
```

---

## Paso 2 — Crear proyecto en Supabase

1. Ve a [supabase.com](https://supabase.com) → **New project**
2. Elige nombre, contraseña de base de datos y región (ej: South America)
3. Espera ~2 minutos a que el proyecto se inicialice
4. Ve a **SQL Editor → New query**
5. Pega el contenido completo de `RAICE_maestro.sql` y ejecuta (**Run**)
6. Verifica en **Table Editor** que se crearon las tablas (deben aparecer ~29 tablas con prefijo `raice_`)

> ⚠️ El script es idempotente: puedes ejecutarlo múltiples veces sin romper nada.

### Obtener las credenciales de Supabase
1. En tu proyecto Supabase → **Settings → API**
2. Copia:
   - **Project URL** → es tu `SUPABASE_URL`
   - **service_role key** (sección "Project API keys") → es tu `SUPABASE_SERVICE_ROLE_KEY`

> ⚠️ La `service_role key` es secreta. Nunca la expongas en código público.

---

## Paso 3 — Subir código a GitHub

```bash
git init
git add .
git commit -m "RAICE instalación inicial"
git remote add origin https://github.com/TU_USUARIO/raice-mi-colegio.git
git push -u origin main
```

---

## Paso 4 — Crear proyecto en Vercel

1. Ve a [vercel.com](https://vercel.com) → **Add New → Project**
2. Importa tu repositorio GitHub
3. En **Framework Preset**: deja en **Other** (Vercel detecta el `vercel.json` automáticamente)
4. En **Root Directory**: deja vacío (raíz del proyecto)
5. **NO** modifiques Build Settings

---

## Paso 5 — ⚠️ Configurar variables de entorno (CRÍTICO)

En Vercel → tu proyecto → **Settings → Environment Variables**

Agrega estas **3 variables** seleccionando los 3 entornos (Production, Preview, Development):

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` (tu Project URL) |
| `SUPABASE_SERVICE_ROLE_KEY` | tu service_role key de Supabase |
| `JWT_SECRET` | una cadena aleatoria larga y segura (ver abajo) |

### Generar un JWT_SECRET seguro
Puedes usar cualquiera de estos métodos:

```bash
# Con Node.js
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

# Con OpenSSL
openssl rand -hex 48
```

Ejemplo de valor válido: `a3f8e2c1d9b47...` (cadena larga de letras y números)

> ⚠️ Si `JWT_SECRET` no está configurado, la app no arranca (falla en arranque).

---

## Paso 6 — Desplegar

Haz clic en **Deploy**. En ~60 segundos tendrás tu URL:
`https://raice-mi-colegio.vercel.app`

---

## Paso 7 — Primer ingreso

| Campo | Valor |
|---|---|
| URL | `https://tu-proyecto.vercel.app/login.html` |
| Usuario | `superadmin` |
| Contraseña | `raice2025` |

> ⚠️ **Cambia la contraseña inmediatamente** desde Mi Perfil → Cambiar contraseña.

---

## Paso 8 — Configurar el sistema

Desde el panel **Superadministrador → Configuración**:

1. **Datos de la institución**: nombre del colegio, municipio, código DANE, año lectivo
2. **Logo del colegio**: sube el escudo en Configuración (aparece en el sidebar)
3. **Horario de timbres**: define las horas de clase con inicio y fin
4. **Ventana de corrección de lista**: define hasta cuándo puede un docente corregir asistencia

Desde **Usuarios del sistema**:
- Crea el coordinador (rol: `admin`)
- Crea los docentes (rol: `teacher`)

Desde **Grados y cursos**:
- Crea los cursos (6°1, 6°2, 7°1, etc.)

Desde **Estudiantes → Importar**:
- Sube el listado en formato CSV o Excel

---

## Formato del Excel/CSV de estudiantes

**Obligatorias:** `Nombres`, `Apellidos`, `Grado`
**Opcionales:** `Curso`, `Tipo Doc`, `Documento`, `Fecha Nacimiento`, `Telefono`,
`Acudiente`, `Parentesco`, `Telefono Acudiente`

```
Nombres,Apellidos,Grado,Curso,Tipo Doc,Documento,Fecha Nacimiento,Telefono,Acudiente,Parentesco,Telefono Acudiente
Carlos,Parra Gómez,7,1,TI,1023456789,2011-03-15,3217654321,Pedro Parra López,Padre,3001112233
Diana,Rodríguez López,7,1,TI,1023456790,2012-07-22,3158889900,Ana Ruiz Díaz,Madre,3004445566
```

- **Grado**: número solo (7, no "Séptimo" ni "7°"). Transición/Pre-jardín se mapean internamente.
- **Curso**: número solo (1, no "01" ni "Uno").
- **Acudiente / Parentesco / Telefono Acudiente**: opcionales. Si la celda del teléfono del
  acudiente viene vacía, NO sobrescribe el que ya exista. La detección de columnas es flexible
  (reconoce variantes de encabezado), y descarga la plantilla desde el panel para el formato exacto.
- El importador empareja por **nombre + grado + curso**: actualiza si ya existe, crea si no.
  Bloquea documentos duplicados.

---

## URLs del sistema

| URL | Quién accede |
|---|---|
| `/login.html` | Todos los usuarios |
| `/superadmin.html` | Superadministrador |
| `/admin.html` | Coordinador |
| `/docente.html` | Docentes |
| `/portal-acudiente.html` | Padres/acudientes (acceso por documento) |
| `/api/health` | Health check de la API |

---

## Solución de problemas comunes

**Error 401 al iniciar sesión**
→ Verifica que `SUPABASE_SERVICE_ROLE_KEY` esté correctamente configurada en Vercel
→ Verifica que el SQL se ejecutó correctamente (deben existir las tablas en Supabase)

**Error 500 en la API**
→ Revisa los logs: Vercel → Functions → ver logs
→ Verifica que `JWT_SECRET` esté configurado
→ Verifica que `SUPABASE_URL` tenga el formato correcto (con `https://`)

**Estudiantes no aparecen después de importar**
→ Verifica que el CSV tenga exactamente los encabezados: `Nombres,Apellidos,Grado,Curso`
→ Asegúrate de que los cursos existan primero (crea los cursos antes de importar)

**Las fuentes o CDN no cargan**
→ El sistema incluye `public/js/chart.umd.min.js` localmente
→ Si Google Fonts falla, los números del dashboard muestran fuente de respaldo (normal)

---

## Actualizar a una versión nueva

```bash
git pull origin main
# No hay migraciones manuales necesarias —
# el SQL usa IF NOT EXISTS y ADD COLUMN IF NOT EXISTS en todos los cambios.
# Para cambios de constraints ejecuta la sección
# "CORRECCIONES DE CONSTRAINTS" del SQL manualmente si actualizas una DB existente.
```

---

## Estructura de archivos clave

```
raice-next/
├── pages/api/[...path].js     # API monolítica (toda la lógica backend, ~9000 líneas)
├── public/
│   ├── login.html             # Pantalla de login
│   ├── admin.html             # Panel coordinador
│   ├── docente.html           # Portal docente
│   ├── superadmin.html        # Panel superadmin
│   ├── rector.html            # Panel rector
│   ├── portal-acudiente.html  # Portal padres (acceso por documento)
│   ├── shared/                # Capa compartida (window.RAICE — ver public/shared/README.md)
│   │   ├── constants/  utils/  data/  domain/
│   └── js/
│       └── chart.umd.min.js   # Chart.js (local, sin CDN)
├── next.config.js             # Configuración Next.js + headers de seguridad
├── vercel.json                # Configuración Vercel + cron jobs
├── RAICE_maestro.sql          # ← Ejecutar en Supabase para instalar (fuente de verdad del esquema)
├── RUNBOOK.md                 # Guía operativa para IA/devs (leer primero al mantener)
├── AGENTS.md                  # Reglas de migración/arquitectura
└── DESPLIEGUE.md              # Esta guía
```

---

## Mantenimiento (para devs/IA)

- **Repo Git real:** `https://github.com/camilopmapp/raice.git` (rama `main`). Vercel auto-despliega
  con cada push.
- El flujo correcto es editar el clon local, validar con `node --check`, y `git push origin main`.
  **No** subir por la web de GitHub (provoca clones locales desactualizados).
- Antes de mantener, lee **RUNBOOK.md** (§3 despliegue, §5 problemas conocidos).

---

*RAICE — guía de instalación. Mantenimiento: ver RUNBOOK.md. Actualizado junio 2026.*

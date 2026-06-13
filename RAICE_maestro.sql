-- =====================================================================
-- RAICE — Script SQL Maestro para instalación desde cero
-- Versión: v12 (mayo 2026) — incluye subgrupos, multisede coordinadores
-- Aplicación: Ruta de Atención Integral para la Convivencia Escolar
--
-- INSTRUCCIONES (instalación nueva):
--   1. Crea un proyecto nuevo en supabase.com
--   2. Ve a SQL Editor → New query
--   3. Pega TODO este archivo y ejecuta (Run)
--   4. Al terminar verás una tabla de verificación con las tablas creadas
--
-- INSTRUCCIONES (actualizar instalación existente):
--   El script es 100 % idempotente: usa IF NOT EXISTS, ADD COLUMN IF NOT EXISTS
--   y ON CONFLICT DO NOTHING en todos lados. Se puede ejecutar múltiples
--   veces sin perder datos ni romper nada.
--
-- VARIABLES DE ENTORNO requeridas en Vercel:
--   SUPABASE_URL              → Supabase → Settings → API → Project URL
--   SUPABASE_SERVICE_ROLE_KEY → Supabase → Settings → API → service_role key
--   JWT_SECRET                → cualquier string seguro de 32+ caracteres
--
-- PRIMER LOGIN:
--   Usuario:    superadmin
--   Contraseña: raice2025
--   ⚠️  Cámbiala inmediatamente desde Configuración → Seguridad
-- =====================================================================


-- =====================================================================
-- SECCIÓN 1: TABLAS
-- Orden respeta dependencias de claves foráneas
-- =====================================================================

-- ─────────────────────────────────────────────────────────────────────
-- 00. SEDES DE LA INSTITUCIÓN
--     Una sede = campus físico (primaria, bachillerato, mixta, etc.)
--     sede_id NULL en users → superadmin/rector (acceso global)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_sedes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  type       TEXT        NOT NULL DEFAULT 'mixta'
                         CHECK (type IN ('primaria','bachillerato','mixta')),
  address    TEXT,
  active     BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 01. USUARIOS DEL SISTEMA
--     Roles: superadmin (dueño), admin/rector (coordinación),
--            teacher (docente)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_users (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT        NOT NULL UNIQUE,
  first_name           TEXT        NOT NULL,
  last_name            TEXT        NOT NULL DEFAULT '',
  email                TEXT,
  role                 TEXT        NOT NULL
                                   CHECK (role IN ('superadmin','admin','rector','teacher','counselor')),
  subject              TEXT,
  sede_id              UUID        REFERENCES raice_sedes(id) ON DELETE SET NULL,
  password_hash        TEXT        NOT NULL,
  active               BOOLEAN     NOT NULL DEFAULT true,
  must_change_password BOOLEAN     NOT NULL DEFAULT false,
  last_login           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 01b. ASIGNACIÓN DE SEDES A COORDINADORES (muchos a muchos)
--      Un admin puede pertenecer a varias sedes.
--      Rector y superadmin no usan esta tabla (ven todo).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_user_sedes (
  user_id  UUID NOT NULL REFERENCES raice_users(id)  ON DELETE CASCADE,
  sede_id  UUID NOT NULL REFERENCES raice_sedes(id)  ON DELETE CASCADE,
  PRIMARY KEY (user_id, sede_id)
);

-- Migración: copiar sede_id existente de coordinadores a la nueva tabla
-- (solo si raice_users tiene columna sede_id — omite si no existe)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'raice_users' AND column_name = 'sede_id'
  ) THEN
    INSERT INTO raice_user_sedes (user_id, sede_id)
    SELECT id, sede_id
    FROM raice_users
    WHERE role = 'admin' AND sede_id IS NOT NULL
    ON CONFLICT DO NOTHING;
  END IF;
END $$;


-- ─────────────────────────────────────────────────────────────────────
-- 02. CONFIGURACIÓN DEL SISTEMA (fila única id = 1)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_config (
  id                        INTEGER     PRIMARY KEY DEFAULT 1,
  school_name               TEXT        DEFAULT 'Institución Educativa',
  location                  TEXT,
  dane_code                 TEXT,
  year                      TEXT        DEFAULT '2026',
  logo_url                  TEXT,
  num_periods               INTEGER     DEFAULT 4,
  periods_config            JSONB,
  classes_per_day           INTEGER     DEFAULT 6,
  session_timeout           INTEGER     DEFAULT 60,
  correction_window         TEXT        DEFAULT 'class_duration'
                                        CHECK (correction_window IN (
                                          'same_day_end',
                                          'same_day_hour',
                                          'class_duration',
                                          'next_day_end'
                                        )),
  correction_window_minutes INTEGER     DEFAULT 55,
  correction_window_hour    TEXT        DEFAULT '23:59',
  backup_email              TEXT,
  resend_api_key            TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 03. CURSOS Y SUBGRUPOS
--     type = 'normal'   → curso regular (grado + número)
--     type = 'subgroup' → subgrupo transversal (nombre libre, grado opcional)
--     grade y number son nullable para permitir subgrupos sin grado fijo.
--     La restricción UNIQUE(grade, number) solo aplica a filas normales
--     porque NULL != NULL en PostgreSQL (no genera conflicto).
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_courses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  grade       INTEGER,
  number      INTEGER,
  section     TEXT,
  type        TEXT        NOT NULL DEFAULT 'normal'
                          CHECK (type IN ('normal','subgroup')),
  name        TEXT,
  sede_id     UUID        REFERENCES raice_sedes(id) ON DELETE SET NULL,
  director_id UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (grade, number, sede_id)
);


-- ─────────────────────────────────────────────────────────────────────
-- 04. ASIGNACIÓN DOCENTE ↔ CURSO
--     Aplica igual a cursos normales y subgrupos.
--     Un docente puede dictar varias materias en el mismo curso.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_teacher_courses (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID        NOT NULL REFERENCES raice_users(id)   ON DELETE RESTRICT,
  course_id  UUID        NOT NULL REFERENCES raice_courses(id) ON DELETE RESTRICT,
  subject    TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, course_id, subject)
);


-- ─────────────────────────────────────────────────────────────────────
-- 05. HORARIO DE TIMBRES
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_bell_schedule (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  class_hour INTEGER     NOT NULL UNIQUE CHECK (class_hour BETWEEN 1 AND 12),
  start_time TIME        NOT NULL,
  end_time   TIME        NOT NULL,
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 06. HORARIOS DE CLASE
--     day_of_week: 1=Lunes … 7=Domingo
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_schedules (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_course_id UUID        NOT NULL REFERENCES raice_teacher_courses(id) ON DELETE CASCADE,
  day_of_week       INTEGER     NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  class_hour        INTEGER     NOT NULL CHECK (class_hour BETWEEN 1 AND 12),
  start_time        TIME,
  end_time          TIME,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_course_id, day_of_week, class_hour)
);


-- ─────────────────────────────────────────────────────────────────────
-- 07. ESTUDIANTES
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_students (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT        NOT NULL,
  last_name  TEXT        NOT NULL,
  grade      INTEGER     NOT NULL,
  course     INTEGER     NOT NULL,
  course_id  UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  code       TEXT        UNIQUE,
  email      TEXT,
  phone      TEXT,
  doc_type   TEXT        DEFAULT 'TI',
  doc_number TEXT,
  birth_date DATE,
  notes      TEXT,
  status     TEXT        NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active','transferred','retired','graduated','desertor')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 08. MIEMBROS DE SUBGRUPOS
--     Un estudiante puede pertenecer a MÚLTIPLES subgrupos.
--     El constraint garantiza que no se duplique la membresía dentro
--     del mismo subgrupo, pero permite estar en varios subgrupos distintos.
--     Al eliminar el subgrupo o el estudiante, el registro se elimina solo.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_subgroup_members (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  subgroup_course_id UUID        NOT NULL REFERENCES raice_courses(id)  ON DELETE CASCADE,
  student_id         UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (subgroup_course_id, student_id)
);


-- ─────────────────────────────────────────────────────────────────────
-- 09. ASISTENCIA
--     status: P=Presente, A=Ausente, PE=Con permiso, T=Tardanza,
--             S=Actividad especial/sin lista, NR=Sin registro (omisión)
--     course_id puede apuntar a un curso normal o a un subgrupo.
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_attendance (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID        NOT NULL REFERENCES raice_students(id) ON DELETE RESTRICT,
  course_id         UUID        NOT NULL REFERENCES raice_courses(id)  ON DELETE RESTRICT,
  teacher_id        UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  date              DATE        NOT NULL,
  class_hour        INTEGER     NOT NULL DEFAULT 1,
  status            TEXT        NOT NULL DEFAULT 'P'
                                CHECK (status IN ('P','A','PE','T','S','NR')),
  activity_note     TEXT,
  corrected_by      UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  corrected_at      TIMESTAMPTZ,
  correction_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, date, course_id, class_hour)
);


-- ─────────────────────────────────────────────────────────────────────
-- 10. EXCUSAS / PERMISOS DE INASISTENCIA
--     horas: NULL = todo el día; {1,2} = solo esas horas
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_excusas (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  course_id     UUID        NOT NULL REFERENCES raice_courses(id)  ON DELETE CASCADE,
  date          DATE        NOT NULL,
  motivo        TEXT        NOT NULL,
  horas         INTEGER[],
  registered_by UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, date)
);


-- ─────────────────────────────────────────────────────────────────────
-- 11. CATÁLOGO DE FALTAS (Manual de Convivencia)
--     Tipos I, II y III; categorías: academica, convivencia, bullying
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_faltas_catalogo (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        INTEGER     NOT NULL CHECK (tipo IN (1,2,3)),
  categoria   TEXT        NOT NULL CHECK (categoria IN ('academica','convivencia','bullying')),
  numeral     TEXT        NOT NULL,
  descripcion TEXT        NOT NULL,
  activa      BOOLEAN     NOT NULL DEFAULT true,
  orden       INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_falta_tipo_cat_num UNIQUE (tipo, categoria, numeral)
);


-- ─────────────────────────────────────────────────────────────────────
-- 12. CASOS DE CONVIVENCIA (RAICE)
--     type: 1=Tipo I, 2=Tipo II, 3=Tipo III
--     status: open → tracking → closed
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_cases (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         UUID        REFERENCES raice_students(id) ON DELETE SET NULL,
  student_name       TEXT        NOT NULL,
  grade              INTEGER,
  course             INTEGER,
  course_id          UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  teacher_id         UUID        REFERENCES raice_users(id)   ON DELETE SET NULL,
  type               INTEGER     NOT NULL CHECK (type IN (1,2,3)),
  description        TEXT        NOT NULL,
  actions_taken      TEXT,
  notes              TEXT,
  status             TEXT        NOT NULL DEFAULT 'open'
                                 CHECK (status IN ('open','tracking','closed')),
  closed_at          TIMESTAMPTZ,
  closed_by          UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  falta_id           UUID        REFERENCES raice_faltas_catalogo(id) ON DELETE SET NULL,
  falta_numeral      TEXT,
  falta_descripcion  TEXT,
  falta_categoria    TEXT,
  otros_involucrados TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 13. SEGUIMIENTOS A CASOS
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_followups (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id             UUID        NOT NULL REFERENCES raice_cases(id) ON DELETE CASCADE,
  coordinator_id      UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  coordinator_name    TEXT,
  actions             TEXT        NOT NULL,
  descargos           TEXT,
  descargo_estudiante TEXT,
  status              TEXT        NOT NULL DEFAULT 'tracking'
                                  CHECK (status IN ('tracking','closed')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 14. ESCALONES DEL PROCESO TIPO I
--     Hasta 4 escalones antes de escalar a Tipo II
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_tipo1_escalones (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID        NOT NULL REFERENCES raice_cases(id) ON DELETE CASCADE,
  numero_escalon   INTEGER     NOT NULL CHECK (numero_escalon BETWEEN 1 AND 5),
  tipo_llamado     TEXT        NOT NULL
                               CHECK (tipo_llamado IN (
                                 'verbal',
                                 'escrito',
                                 'escrito_con_mediador',
                                 'citacion_acudiente',
                                 'cierre'
                               )),
  descripcion      TEXT        NOT NULL,
  descargos        TEXT,
  compromiso       TEXT,
  compromiso_fecha DATE,
  garante          TEXT,
  created_by       UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 15. OBSERVACIONES DEL OBSERVADOR DIGITAL
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_observations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  teacher_id UUID        REFERENCES raice_users(id)   ON DELETE SET NULL,
  course_id  UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  type       TEXT        NOT NULL DEFAULT 'neutral'
                         CHECK (type IN ('positive','neutral','negative')),
  text       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 16. COMPROMISOS
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_commitments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID        REFERENCES raice_cases(id)    ON DELETE SET NULL,
  student_id   UUID        REFERENCES raice_students(id) ON DELETE SET NULL,
  description  TEXT        NOT NULL,
  signed_by    TEXT        DEFAULT '',
  due_date     DATE,
  fulfilled    BOOLEAN     NOT NULL DEFAULT false,
  fulfilled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 17. CITACIONES A PADRES / ACUDIENTES
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_citations (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID        REFERENCES raice_students(id) ON DELETE SET NULL,
  student_name   TEXT        NOT NULL,
  case_id        UUID        REFERENCES raice_cases(id) ON DELETE SET NULL,
  coordinator_id UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  reason         TEXT        NOT NULL,
  date_time      TIMESTAMPTZ,
  place          TEXT        DEFAULT 'Rectoría / Coordinación',
  attended       BOOLEAN     NOT NULL DEFAULT false,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 18. RETIROS DE CLASE
--     status: pending → reviewed → case_opened
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_classroom_removals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID        NOT NULL REFERENCES raice_students(id) ON DELETE RESTRICT,
  teacher_id  UUID        NOT NULL REFERENCES raice_users(id)    ON DELETE RESTRICT,
  course_id   UUID        NOT NULL REFERENCES raice_courses(id)  ON DELETE RESTRICT,
  date        DATE        NOT NULL,
  class_hour  INTEGER,
  reason      TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','reviewed','case_opened')),
  reviewed_by UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 19. SUSPENSIONES
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_suspensions (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID        NOT NULL REFERENCES raice_students(id) ON DELETE RESTRICT,
  coordinator_id UUID        NOT NULL REFERENCES raice_users(id)    ON DELETE RESTRICT,
  start_date     DATE        NOT NULL,
  end_date       DATE        NOT NULL,
  reason         TEXT        NOT NULL,
  case_id        UUID        REFERENCES raice_cases(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 20. NOTIFICACIONES INTERNAS
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  to_user_id   UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  from_user_id UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  type         TEXT        NOT NULL,
  title        TEXT        NOT NULL,
  body         TEXT,
  link_id      UUID,
  read         BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 21. LOGS DE ACTIVIDAD DEL SISTEMA
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  event_type TEXT        NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 22. ACUDIENTES / PADRES DE FAMILIA (portal público)
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_acudientes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  phone            TEXT,
  email            TEXT,
  relationship     TEXT        DEFAULT 'Acudiente',
  access_token     TEXT        UNIQUE NOT NULL,
  token_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 23. PERÍODOS ACADÉMICOS
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_periods (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  start_date DATE        NOT NULL,
  end_date   DATE        NOT NULL,
  year       INTEGER     NOT NULL,
  period_num INTEGER     NOT NULL,
  active     BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (year, period_num)
);


-- ─────────────────────────────────────────────────────────────────────
-- 24. CALENDARIO ESCOLAR
--     type: holiday=festivo, vacation=vacaciones,
--           event=evento, institutional_day=día institucional
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_calendar (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE        NOT NULL,
  name       TEXT        NOT NULL,
  type       TEXT        NOT NULL DEFAULT 'holiday'
                         CHECK (type IN ('holiday','vacation','event','institutional_day')),
  year       INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 25. AUSENCIAS DE DOCENTES
--     hours_absent: NULL = día completo; {1,3} = horas específicas
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_teacher_absences (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id    UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  date          DATE        NOT NULL,
  hours_absent  INTEGER[],
  reason        TEXT,
  registered_by UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 26. REEMPLAZOS DE DOCENTES AUSENTES
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_absence_replacements (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  absence_id             UUID        NOT NULL REFERENCES raice_teacher_absences(id) ON DELETE CASCADE,
  replacement_teacher_id UUID        NOT NULL REFERENCES raice_users(id) ON DELETE RESTRICT,
  course_id              UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  class_hour             INTEGER,
  notes                  TEXT,
  assigned_by            UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ─────────────────────────────────────────────────────────────────────
-- 27. HISTORIAL DE CAMBIOS DE GRADO / CURSO
-- ─────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_student_grade_history (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  from_grade     INTEGER     NOT NULL,
  from_course    INTEGER     NOT NULL,
  from_course_id UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  to_grade       INTEGER     NOT NULL,
  to_course      INTEGER     NOT NULL,
  to_course_id   UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  reason         TEXT        DEFAULT 'correction'
                             CHECK (reason IN ('promotion','coexistence','correction','other')),
  notes          TEXT,
  changed_by     UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- =====================================================================
-- SECCIÓN 2: CORRECCIONES PARA INSTALACIONES EXISTENTES
-- Seguras sobre instalaciones anteriores — idempotentes
-- =====================================================================

-- Roles: asegurar que todos los roles estén incluidos
ALTER TABLE raice_users DROP CONSTRAINT IF EXISTS raice_users_role_check;
ALTER TABLE raice_users ADD CONSTRAINT raice_users_role_check
  CHECK (role IN ('superadmin','admin','rector','teacher','counselor'));

-- Estudiantes: incluir 'graduated' y 'desertor' para fin de año escolar y deserción
ALTER TABLE raice_students DROP CONSTRAINT IF EXISTS raice_students_status_check;
ALTER TABLE raice_students ADD CONSTRAINT raice_students_status_check
  CHECK (status IN ('active','transferred','retired','graduated','desertor'));

-- Asistencia: incluir S (actividad especial) y NR (sin registro / omisión)
ALTER TABLE raice_attendance DROP CONSTRAINT IF EXISTS raice_attendance_status_check;
ALTER TABLE raice_attendance ADD CONSTRAINT raice_attendance_status_check
  CHECK (status IN ('P','A','PE','T','S','NR'));

-- Asistencia: eliminar unique sin class_hour (versiones antiguas)
ALTER TABLE raice_attendance
  DROP CONSTRAINT IF EXISTS raice_attendance_student_id_date_course_id_key;

-- Asignación docente: eliminar unique sin subject (versiones antiguas)
ALTER TABLE raice_teacher_courses
  DROP CONSTRAINT IF EXISTS raice_teacher_courses_teacher_id_course_id_key;

-- Observaciones: columna de asignatura
ALTER TABLE raice_observations ADD COLUMN IF NOT EXISTS subject TEXT;

-- Columnas de auditoría de asistencia
ALTER TABLE raice_attendance ADD COLUMN IF NOT EXISTS corrected_by      UUID REFERENCES raice_users(id) ON DELETE SET NULL;
ALTER TABLE raice_attendance ADD COLUMN IF NOT EXISTS corrected_at      TIMESTAMPTZ;
ALTER TABLE raice_attendance ADD COLUMN IF NOT EXISTS correction_reason TEXT;
ALTER TABLE raice_attendance ADD COLUMN IF NOT EXISTS activity_note     TEXT;

-- Config: columnas de notificaciones por email
ALTER TABLE raice_config ADD COLUMN IF NOT EXISTS correction_window         TEXT DEFAULT 'class_duration';
ALTER TABLE raice_config ADD COLUMN IF NOT EXISTS correction_window_minutes INTEGER DEFAULT 55;
ALTER TABLE raice_config ADD COLUMN IF NOT EXISTS correction_window_hour    TEXT DEFAULT '23:59';
ALTER TABLE raice_config ADD COLUMN IF NOT EXISTS session_timeout           INTEGER DEFAULT 60;

-- Fix: si correction_window_hour existe como INTEGER, convertir a TEXT
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'raice_config'
      AND column_name = 'correction_window_hour'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE raice_config ALTER COLUMN correction_window_hour TYPE TEXT USING correction_window_hour::TEXT;
    ALTER TABLE raice_config ALTER COLUMN correction_window_hour SET DEFAULT '23:59';
  END IF;
END $$;
ALTER TABLE raice_config ADD COLUMN IF NOT EXISTS backup_email              TEXT;
ALTER TABLE raice_config ADD COLUMN IF NOT EXISTS resend_api_key            TEXT;

-- Estudiantes: teléfono para importación SIMAT
ALTER TABLE raice_students ADD COLUMN IF NOT EXISTS phone TEXT;

-- Acudientes: expiración de token
ALTER TABLE raice_acudientes ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

-- Casos: columnas de falta del catálogo
ALTER TABLE raice_cases ADD COLUMN IF NOT EXISTS falta_id           UUID REFERENCES raice_faltas_catalogo(id) ON DELETE SET NULL;
ALTER TABLE raice_cases ADD COLUMN IF NOT EXISTS falta_numeral      TEXT;
ALTER TABLE raice_cases ADD COLUMN IF NOT EXISTS falta_descripcion  TEXT;
ALTER TABLE raice_cases ADD COLUMN IF NOT EXISTS falta_categoria    TEXT;
ALTER TABLE raice_cases ADD COLUMN IF NOT EXISTS otros_involucrados TEXT;

-- Seguimientos: columnas extendidas
ALTER TABLE raice_followups ADD COLUMN IF NOT EXISTS descargos           TEXT;
ALTER TABLE raice_followups ADD COLUMN IF NOT EXISTS descargo_estudiante TEXT;
ALTER TABLE raice_followups ADD COLUMN IF NOT EXISTS coordinator_name    TEXT;

-- ── SUBGRUPOS: columnas en raice_courses ────────────────────────────
-- Para instalaciones existentes que no tenían estas columnas
ALTER TABLE raice_courses ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE raice_courses ADD COLUMN IF NOT EXISTS name TEXT;

-- Agregar check constraint de type si no existe
ALTER TABLE raice_courses DROP CONSTRAINT IF EXISTS raice_courses_type_check;
ALTER TABLE raice_courses ADD CONSTRAINT raice_courses_type_check
  CHECK (type IN ('normal','subgroup'));

-- Escalones Tipo I: incluir 'cierre' en tipo_llamado y permitir numero_escalon hasta 5
ALTER TABLE raice_tipo1_escalones DROP CONSTRAINT IF EXISTS raice_tipo1_escalones_tipo_llamado_check;
ALTER TABLE raice_tipo1_escalones ADD CONSTRAINT raice_tipo1_escalones_tipo_llamado_check
  CHECK (tipo_llamado IN ('verbal','escrito','escrito_con_mediador','citacion_acudiente','cierre'));
ALTER TABLE raice_tipo1_escalones DROP CONSTRAINT IF EXISTS raice_tipo1_escalones_numero_escalon_check;
ALTER TABLE raice_tipo1_escalones ADD CONSTRAINT raice_tipo1_escalones_numero_escalon_check
  CHECK (numero_escalon BETWEEN 1 AND 5);

-- Hacer grade y number nullable (los subgrupos no tienen número de grupo)
ALTER TABLE raice_courses ALTER COLUMN grade DROP NOT NULL;
ALTER TABLE raice_courses ALTER COLUMN number DROP NOT NULL;

-- Proteger registros históricos: ON DELETE RESTRICT
ALTER TABLE raice_attendance
  DROP CONSTRAINT IF EXISTS raice_attendance_student_id_fkey,
  ADD  CONSTRAINT raice_attendance_student_id_fkey
       FOREIGN KEY (student_id) REFERENCES raice_students(id) ON DELETE RESTRICT;

ALTER TABLE raice_attendance
  DROP CONSTRAINT IF EXISTS raice_attendance_course_id_fkey,
  ADD  CONSTRAINT raice_attendance_course_id_fkey
       FOREIGN KEY (course_id) REFERENCES raice_courses(id) ON DELETE RESTRICT;

ALTER TABLE raice_classroom_removals
  DROP CONSTRAINT IF EXISTS raice_classroom_removals_student_id_fkey,
  ADD  CONSTRAINT raice_classroom_removals_student_id_fkey
       FOREIGN KEY (student_id) REFERENCES raice_students(id) ON DELETE RESTRICT;

ALTER TABLE raice_classroom_removals
  DROP CONSTRAINT IF EXISTS raice_classroom_removals_teacher_id_fkey,
  ADD  CONSTRAINT raice_classroom_removals_teacher_id_fkey
       FOREIGN KEY (teacher_id) REFERENCES raice_users(id) ON DELETE RESTRICT;

ALTER TABLE raice_classroom_removals
  DROP CONSTRAINT IF EXISTS raice_classroom_removals_course_id_fkey,
  ADD  CONSTRAINT raice_classroom_removals_course_id_fkey
       FOREIGN KEY (course_id) REFERENCES raice_courses(id) ON DELETE RESTRICT;

ALTER TABLE raice_suspensions
  DROP CONSTRAINT IF EXISTS raice_suspensions_student_id_fkey,
  ADD  CONSTRAINT raice_suspensions_student_id_fkey
       FOREIGN KEY (student_id) REFERENCES raice_students(id) ON DELETE RESTRICT;

ALTER TABLE raice_suspensions
  DROP CONSTRAINT IF EXISTS raice_suspensions_coordinator_id_fkey,
  ADD  CONSTRAINT raice_suspensions_coordinator_id_fkey
       FOREIGN KEY (coordinator_id) REFERENCES raice_users(id) ON DELETE RESTRICT;

ALTER TABLE raice_teacher_courses
  DROP CONSTRAINT IF EXISTS raice_teacher_courses_teacher_id_fkey,
  ADD  CONSTRAINT raice_teacher_courses_teacher_id_fkey
       FOREIGN KEY (teacher_id) REFERENCES raice_users(id) ON DELETE RESTRICT;

ALTER TABLE raice_teacher_courses
  DROP CONSTRAINT IF EXISTS raice_teacher_courses_course_id_fkey,
  ADD  CONSTRAINT raice_teacher_courses_course_id_fkey
       FOREIGN KEY (course_id) REFERENCES raice_courses(id) ON DELETE RESTRICT;

-- ── Multi-sede ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS raice_sedes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT        NOT NULL,
  type       TEXT        NOT NULL DEFAULT 'mixta'
                         CHECK (type IN ('primaria','bachillerato','mixta')),
  address    TEXT,
  active     BOOLEAN     NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE raice_users   ADD COLUMN IF NOT EXISTS sede_id UUID REFERENCES raice_sedes(id) ON DELETE SET NULL;
ALTER TABLE raice_courses ADD COLUMN IF NOT EXISTS sede_id UUID REFERENCES raice_sedes(id) ON DELETE SET NULL;

-- Actualizar constraint único de cursos para incluir sede
ALTER TABLE raice_courses DROP CONSTRAINT IF EXISTS raice_courses_grade_number_key;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'raice_courses_grade_number_sede_key'
  ) THEN
    ALTER TABLE raice_courses ADD CONSTRAINT raice_courses_grade_number_sede_key
      UNIQUE (grade, number, sede_id);
  END IF;
END $$;


-- =====================================================================
-- SECCIÓN 3: ÍNDICES
-- =====================================================================

-- Sedes
CREATE INDEX IF NOT EXISTS idx_sedes_active        ON raice_sedes(active);
-- Asignaciones coordinador ↔ sede
CREATE INDEX IF NOT EXISTS idx_user_sedes_user     ON raice_user_sedes(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sedes_sede     ON raice_user_sedes(sede_id);
-- Usuarios por sede
CREATE INDEX IF NOT EXISTS idx_users_sede          ON raice_users(sede_id);
-- Cursos por sede
CREATE INDEX IF NOT EXISTS idx_courses_sede        ON raice_courses(sede_id);

-- Usuarios
CREATE INDEX IF NOT EXISTS idx_users_role     ON raice_users(role);
CREATE INDEX IF NOT EXISTS idx_users_active   ON raice_users(active);
CREATE INDEX IF NOT EXISTS idx_users_username ON raice_users(username);

-- Cursos / asignaciones
CREATE INDEX IF NOT EXISTS idx_courses_type ON raice_courses(type);
CREATE INDEX IF NOT EXISTS idx_tc_teacher   ON raice_teacher_courses(teacher_id);
CREATE INDEX IF NOT EXISTS idx_tc_course    ON raice_teacher_courses(course_id);
CREATE INDEX IF NOT EXISTS idx_schedules_tc ON raice_schedules(teacher_course_id);

-- Subgrupos
CREATE INDEX IF NOT EXISTS idx_subgroup_members_subgroup ON raice_subgroup_members(subgroup_course_id);
CREATE INDEX IF NOT EXISTS idx_subgroup_members_student  ON raice_subgroup_members(student_id);

-- Estudiantes
CREATE INDEX IF NOT EXISTS idx_students_grade      ON raice_students(grade, course);
CREATE INDEX IF NOT EXISTS idx_students_course_id  ON raice_students(course_id);
CREATE INDEX IF NOT EXISTS idx_students_doc_number ON raice_students(doc_number);
CREATE INDEX IF NOT EXISTS idx_students_status     ON raice_students(status);

-- Asistencia
CREATE INDEX IF NOT EXISTS idx_att_date         ON raice_attendance(date);
CREATE INDEX IF NOT EXISTS idx_att_student      ON raice_attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_att_course       ON raice_attendance(course_id);
CREATE INDEX IF NOT EXISTS idx_att_teacher      ON raice_attendance(teacher_id);
CREATE INDEX IF NOT EXISTS idx_att_student_date ON raice_attendance(student_id, date);
CREATE INDEX IF NOT EXISTS idx_att_date_hour    ON raice_attendance(date, class_hour);

-- Excusas
CREATE INDEX IF NOT EXISTS idx_excusas_student ON raice_excusas(student_id, date);
CREATE INDEX IF NOT EXISTS idx_excusas_course  ON raice_excusas(course_id, date);
CREATE INDEX IF NOT EXISTS idx_excusas_horas   ON raice_excusas USING GIN (horas) WHERE horas IS NOT NULL;

-- Casos
CREATE INDEX IF NOT EXISTS idx_cases_student   ON raice_cases(student_id);
CREATE INDEX IF NOT EXISTS idx_cases_teacher   ON raice_cases(teacher_id);
CREATE INDEX IF NOT EXISTS idx_cases_course    ON raice_cases(course_id);
CREATE INDEX IF NOT EXISTS idx_cases_status    ON raice_cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_closed_by ON raice_cases(closed_by);

-- Convivencia y seguimiento
CREATE INDEX IF NOT EXISTS idx_followups_case      ON raice_followups(case_id);
CREATE INDEX IF NOT EXISTS idx_escalones_case      ON raice_tipo1_escalones(case_id, numero_escalon);
CREATE INDEX IF NOT EXISTS idx_obs_student         ON raice_observations(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_commitments_student ON raice_commitments(student_id);
CREATE INDEX IF NOT EXISTS idx_commitments_due     ON raice_commitments(due_date, fulfilled);
CREATE INDEX IF NOT EXISTS idx_citations_student   ON raice_citations(student_id);
CREATE INDEX IF NOT EXISTS idx_removals_student    ON raice_classroom_removals(student_id);
CREATE INDEX IF NOT EXISTS idx_removals_teacher    ON raice_classroom_removals(teacher_id);
CREATE INDEX IF NOT EXISTS idx_removals_date       ON raice_classroom_removals(date);
CREATE INDEX IF NOT EXISTS idx_suspensions_student ON raice_suspensions(student_id);
CREATE INDEX IF NOT EXISTS idx_suspensions_dates   ON raice_suspensions(start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_suspensions_case    ON raice_suspensions(case_id);

-- Catálogo de faltas
CREATE INDEX IF NOT EXISTS idx_faltas_tipo      ON raice_faltas_catalogo(tipo, activa);
CREATE INDEX IF NOT EXISTS idx_faltas_categoria ON raice_faltas_catalogo(categoria);

-- Notificaciones y logs
CREATE INDEX IF NOT EXISTS idx_notifications_user ON raice_notifications(to_user_id, read);
CREATE INDEX IF NOT EXISTS idx_logs_user          ON raice_logs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_logs_created       ON raice_logs(created_at DESC);

-- Periodos y calendario
CREATE INDEX IF NOT EXISTS idx_periods_active ON raice_periods(active);
CREATE INDEX IF NOT EXISTS idx_calendar_year  ON raice_calendar(year, date);

-- Acudientes
CREATE INDEX IF NOT EXISTS idx_acudientes_student ON raice_acudientes(student_id);
CREATE INDEX IF NOT EXISTS idx_acudientes_token   ON raice_acudientes(access_token);

-- Ausencias y reemplazos docentes
CREATE INDEX IF NOT EXISTS idx_teacher_absences_teacher     ON raice_teacher_absences(teacher_id);
CREATE INDEX IF NOT EXISTS idx_teacher_absences_date        ON raice_teacher_absences(date);
CREATE INDEX IF NOT EXISTS idx_absence_replacements_absence ON raice_absence_replacements(absence_id);

-- Historial de grado
CREATE INDEX IF NOT EXISTS idx_grade_history_student    ON raice_student_grade_history(student_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_grade_history_changed_by ON raice_student_grade_history(changed_by);


-- =====================================================================
-- SECCIÓN 3.5: HISTORIA CLÍNICA PSICOLÓGICA
-- =====================================================================

CREATE TABLE IF NOT EXISTS psych_histories (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id               UUID NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  sede_id                  UUID REFERENCES raice_sedes(id),
  created_by               UUID REFERENCES raice_users(id),
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  first_session_date       DATE,
  referral_source          TEXT,
  consultation_reason      TEXT,
  consent_signed           BOOLEAN NOT NULL DEFAULT false,
  consent_signed_by        TEXT,
  consent_date             DATE,
  family_background        TEXT,
  personal_background      TEXT,
  family_composition       TEXT,
  socioeconomic_status     TEXT,
  support_network          TEXT,
  cognitive_area           TEXT,
  emotional_area           TEXT,
  behavioral_area          TEXT,
  social_area              TEXT,
  diagnostic_hypothesis    TEXT,
  initial_intervention_plan TEXT,
  status                   TEXT NOT NULL DEFAULT 'active',
  close_date               DATE,
  close_reason             TEXT,
  close_summary            TEXT,
  close_recommendations    TEXT,
  referred_to              TEXT
);

CREATE TABLE IF NOT EXISTS psych_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id    UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  student_id    UUID NOT NULL REFERENCES raice_students(id),
  created_by    UUID REFERENCES raice_users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_date  DATE NOT NULL,
  session_time  TIME,
  duration_min  INTEGER,
  session_type  TEXT,
  reason        TEXT,
  development   TEXT,
  strategies    TEXT,
  commitments   TEXT,
  next_date     DATE,
  notes         TEXT
);

CREATE TABLE IF NOT EXISTS psych_instruments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id       UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  student_id       UUID NOT NULL REFERENCES raice_students(id),
  created_by       UUID REFERENCES raice_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  application_date DATE NOT NULL,
  instrument_name  TEXT NOT NULL,
  results          TEXT,
  interpretation   TEXT,
  file_url         TEXT
);

CREATE TABLE IF NOT EXISTS psych_goals (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id   UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  created_by   UUID REFERENCES raice_users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  objective    TEXT NOT NULL,
  strategies   TEXT,
  indicators   TEXT,
  review_date  DATE,
  status       TEXT NOT NULL DEFAULT 'pending'
);

-- Compromisos de seguimiento (quién, qué, para cuándo, si se cumplió)
CREATE TABLE IF NOT EXISTS psych_commitments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id      UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  session_id      UUID REFERENCES psych_sessions(id) ON DELETE SET NULL,
  created_by      UUID REFERENCES raice_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_to     TEXT NOT NULL DEFAULT 'estudiante',
  description     TEXT NOT NULL,
  due_date        DATE,
  status          TEXT NOT NULL DEFAULT 'pending',
  follow_up_note  TEXT,
  follow_up_date  DATE
);

-- Valoración periódica de áreas (para gráfica de evolución)
CREATE TABLE IF NOT EXISTS psych_area_ratings (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id       UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  session_id       UUID REFERENCES psych_sessions(id) ON DELETE SET NULL,
  created_by       UUID REFERENCES raice_users(id),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  rating_date      DATE NOT NULL,
  cognitive_score  SMALLINT CHECK (cognitive_score BETWEEN 1 AND 5),
  emotional_score  SMALLINT CHECK (emotional_score BETWEEN 1 AND 5),
  behavioral_score SMALLINT CHECK (behavioral_score BETWEEN 1 AND 5),
  social_score     SMALLINT CHECK (social_score BETWEEN 1 AND 5),
  overall_note     TEXT
);

-- Señales de alerta y situaciones críticas
CREATE TABLE IF NOT EXISTS psych_risk_flags (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id      UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  student_id      UUID NOT NULL REFERENCES raice_students(id),
  created_by      UUID REFERENCES raice_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  flag_date       DATE NOT NULL,
  category        TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'moderate',
  description     TEXT NOT NULL,
  action_taken    TEXT,
  reported_to     TEXT,
  active          BOOLEAN NOT NULL DEFAULT true,
  resolution_note TEXT,
  resolved_at     DATE
);

-- Historial de cambios de estado (activo → seguimiento → cerrado, etc.)
CREATE TABLE IF NOT EXISTS psych_status_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  history_id   UUID NOT NULL REFERENCES psych_histories(id) ON DELETE CASCADE,
  changed_by   UUID REFERENCES raice_users(id),
  changed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  note         TEXT
);

CREATE INDEX IF NOT EXISTS idx_psych_histories_student   ON psych_histories(student_id);
CREATE INDEX IF NOT EXISTS idx_psych_histories_sede      ON psych_histories(sede_id);
CREATE INDEX IF NOT EXISTS idx_psych_sessions_history    ON psych_sessions(history_id);
CREATE INDEX IF NOT EXISTS idx_psych_instruments_history ON psych_instruments(history_id);
CREATE INDEX IF NOT EXISTS idx_psych_goals_history       ON psych_goals(history_id);
CREATE INDEX IF NOT EXISTS idx_psych_commitments_history ON psych_commitments(history_id);
CREATE INDEX IF NOT EXISTS idx_psych_area_ratings_history ON psych_area_ratings(history_id);
CREATE INDEX IF NOT EXISTS idx_psych_risk_flags_history  ON psych_risk_flags(history_id);
CREATE INDEX IF NOT EXISTS idx_psych_status_log_history  ON psych_status_log(history_id);

-- =====================================================================
-- SECCIÓN 3.6: HORARIOS ESPECIALES
-- =====================================================================

-- Cabecera del día especial (jornada sindical, día de logros, etc.)
CREATE TABLE IF NOT EXISTS raice_special_days (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id     UUID        NOT NULL REFERENCES raice_sedes(id) ON DELETE CASCADE,
  created_by  UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  fecha       DATE        NOT NULL,
  nombre      TEXT        NOT NULL,
  tipo        TEXT        NOT NULL DEFAULT 'jornada_especial',
  descripcion TEXT,
  estado      TEXT        NOT NULL DEFAULT 'activo',
  CONSTRAINT raice_special_days_tipo_check
    CHECK (tipo   IN ('jornada_especial','jornada_sindical','dia_logros','pedagogico','otro')),
  CONSTRAINT raice_special_days_estado_check
    CHECK (estado IN ('activo','cancelado')),
  UNIQUE (sede_id, fecha)
);

-- Bloques del día especial: un bloque = un docente con una asignatura a una hora
CREATE TABLE IF NOT EXISTS raice_special_day_blocks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  special_day_id  UUID        NOT NULL REFERENCES raice_special_days(id) ON DELETE CASCADE,
  teacher_id      UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  course_id       UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  hora_inicio     TIME        NOT NULL,
  duracion_min    INTEGER     NOT NULL DEFAULT 55 CHECK (duracion_min > 0),
  asignatura      TEXT        NOT NULL,
  orden           SMALLINT    NOT NULL DEFAULT 1
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_special_days_sede  ON raice_special_days(sede_id);
CREATE INDEX IF NOT EXISTS idx_special_days_fecha ON raice_special_days(fecha);
CREATE INDEX IF NOT EXISTS idx_special_blocks_day ON raice_special_day_blocks(special_day_id);
CREATE INDEX IF NOT EXISTS idx_special_blocks_teacher ON raice_special_day_blocks(teacher_id);
-- Evita que un docente tenga dos bloques con la misma hora de inicio en el mismo día especial
CREATE UNIQUE INDEX IF NOT EXISTS idx_special_blocks_no_overlap
  ON raice_special_day_blocks(special_day_id, teacher_id, hora_inicio);

-- =====================================================================
-- 3.7  Sedes múltiples para orientadores
-- =====================================================================
CREATE TABLE IF NOT EXISTS raice_counselor_sedes (
  counselor_id UUID NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  sede_id      UUID NOT NULL REFERENCES raice_sedes(id) ON DELETE CASCADE,
  PRIMARY KEY (counselor_id, sede_id)
);
CREATE INDEX IF NOT EXISTS idx_counselor_sedes_counselor ON raice_counselor_sedes(counselor_id);
CREATE INDEX IF NOT EXISTS idx_counselor_sedes_sede      ON raice_counselor_sedes(sede_id);

-- =====================================================================
-- 3.8  Mensajes institucionales (unidireccionales)
-- =====================================================================
CREATE TABLE IF NOT EXISTS raice_messages (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id   UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  sender_role TEXT        NOT NULL,
  type        TEXT        NOT NULL DEFAULT 'info'
                          CHECK (type IN ('info','urgent','reminder')),
  subject     TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  target      TEXT        NOT NULL DEFAULT 'all',
  sede_id     UUID        REFERENCES raice_sedes(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raice_message_reads (
  message_id  UUID        NOT NULL REFERENCES raice_messages(id) ON DELETE CASCADE,
  teacher_id  UUID        NOT NULL REFERENCES raice_users(id)    ON DELETE CASCADE,
  read_at     TIMESTAMPTZ,
  PRIMARY KEY (message_id, teacher_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_sender   ON raice_messages(sender_id);
CREATE INDEX IF NOT EXISTS idx_messages_sede     ON raice_messages(sede_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_teacher ON raice_message_reads(teacher_id);
CREATE INDEX IF NOT EXISTS idx_msg_reads_message ON raice_message_reads(message_id);

-- =====================================================================
-- SECCIÓN 4: FUNCIONES
-- =====================================================================

-- Detecta estudiantes con 3 o más ausencias desde una fecha dada
CREATE OR REPLACE FUNCTION get_repeated_absences(since_date DATE)
RETURNS TABLE(student_name TEXT, grade INTEGER, course INTEGER, count BIGINT, last_date DATE)
LANGUAGE SQL AS $$
  SELECT
    s.first_name || ' ' || s.last_name AS student_name,
    s.grade,
    s.course,
    COUNT(*)           AS count,
    MAX(a.date)::DATE  AS last_date
  FROM raice_attendance a
  JOIN raice_students s ON s.id = a.student_id
  WHERE a.status = 'A' AND a.date >= since_date
  GROUP BY s.id, s.first_name, s.last_name, s.grade, s.course
  HAVING COUNT(*) >= 3
  ORDER BY count DESC
  LIMIT 10;
$$;


-- =====================================================================
-- SECCIÓN 5: TRIGGER — Limpieza de PE al eliminar excusa
-- Al borrar una excusa los registros PE correspondientes se eliminan solos.
-- =====================================================================

CREATE OR REPLACE FUNCTION raice_cleanup_pe_on_excusa_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.horas IS NOT NULL AND array_length(OLD.horas, 1) > 0 THEN
    DELETE FROM raice_attendance
    WHERE student_id = OLD.student_id
      AND date       = OLD.date
      AND status     = 'PE'
      AND class_hour = ANY(OLD.horas::int[]);
  ELSE
    DELETE FROM raice_attendance
    WHERE student_id = OLD.student_id
      AND date       = OLD.date
      AND status     = 'PE';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_cleanup_pe_on_excusa_delete ON raice_excusas;

CREATE TRIGGER trg_cleanup_pe_on_excusa_delete
  BEFORE DELETE ON raice_excusas
  FOR EACH ROW
  EXECUTE FUNCTION raice_cleanup_pe_on_excusa_delete();


-- =====================================================================
-- SECCIÓN 6: DATOS INICIALES
-- =====================================================================

-- ── Configuración base ──────────────────────────────────────────────
INSERT INTO raice_config (
  id, school_name, location, year, num_periods, classes_per_day,
  correction_window, correction_window_minutes, correction_window_hour,
  session_timeout
) VALUES (
  1, 'Nombre de la Institución Educativa', 'Ciudad, Departamento',
  EXTRACT(YEAR FROM now())::TEXT,
  4, 6, 'class_duration', 55, '23:59', 60
) ON CONFLICT (id) DO NOTHING;

-- ── Usuario superadmin inicial ───────────────────────────────────────
-- Contraseña por defecto: raice2025
-- ⚠️  Cámbiala inmediatamente desde el panel Configuración → Seguridad
-- Para usar otra contraseña, genera el hash con Node.js:
--   const b = require('bcryptjs'); console.log(await b.hash('TuClave', 10));
INSERT INTO raice_users (username, first_name, last_name, role, password_hash, active)
VALUES (
  'superadmin',
  'Super',
  'Administrador',
  'superadmin',
  '$2b$10$8K1p/a0dclxPu9OLPaFHHuZ3y5Wd6T1oHkC2NqA7mXeJgVsRbDYIi',
  true
) ON CONFLICT (username) DO NOTHING;

-- ── Períodos académicos (ajusta fechas a tu institución) ─────────────
INSERT INTO raice_periods (name, start_date, end_date, year, period_num, active) VALUES
  ('Primer Período',   '2026-01-19', '2026-03-27', 2026, 1, false),
  ('Segundo Período',  '2026-03-30', '2026-06-12', 2026, 2, false),
  ('Tercer Período',   '2026-06-22', '2026-09-11', 2026, 3, true),
  ('Cuarto Período',   '2026-09-14', '2026-11-27', 2026, 4, false)
ON CONFLICT (year, period_num) DO NOTHING;


-- ── Catálogo de faltas — TIPO I ──────────────────────────────────────

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(1,'academica','1.1','Incumplir la entrega de tareas, talleres o consultas cuando sean solicitadas por los docentes de manera casual o reiterativa.',1),
(1,'academica','1.2','No presentar los exámenes, pruebas o cuestionarios programados con antelación por los docentes.',2),
(1,'academica','1.3','Negarse a participar del trabajo en equipo durante la clase dirigida para talleres o trabajos.',3),
(1,'academica','1.4','No presentar justificación alguna cuando falte un día o varios a la Institución. Su reincidencia pasará a ser una falta grave.',4),
(1,'academica','1.5','No llevar cuaderno de apuntes o notas del área aunque haya sido solicitado previamente.',5),
(1,'academica','1.6','Reportar atrasos en sus apuntes de clase y no interesarse en ponerlos al día.',6),
(1,'academica','1.7','No tener a su alcance los útiles escolares que se requieren para atender las clases.',7),
(1,'academica','1.8','Negarse a realizar actividades de participación colectiva y que impliquen uso de materiales.',8),
(1,'academica','1.9','No cumplir con las acciones disuasivas cuando le sean recomendadas por algún docente.',9)
ON CONFLICT DO NOTHING;

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(1,'convivencia','2.1','Cumplir con más de tres llegadas tarde a la Institución reportadas en el control de asistencia o seguimiento al ausentismo.',1),
(1,'convivencia','2.2','Desacatar las normas de ingreso, permanencia y retiro y las condiciones complementarias a las cuales se comprometió a dar cabal cumplimiento.',2),
(1,'convivencia','2.3','Salir del salón de clases sin solicitar autorización al docente.',3),
(1,'convivencia','2.4','Usar el uniforme en horarios y sitios diferentes a los permitidos por la Institución Educativa.',4),
(1,'convivencia','2.5','Fingir enfermedades para evadir clases o responsabilidades académicas.',5),
(1,'convivencia','2.6','Interrumpir las clases al traer a la Institución radios, grabadoras, audífonos, celulares o aparatos electrónicos.',6),
(1,'convivencia','2.7','Ser sorprendido escuchando durante el descanso o en clase, archivos musicales de drogas auditivas o electrónicas.',7),
(1,'convivencia','2.8','Portar el uniforme de manera inadecuada, con presentación personal deficiente demostrando resistencia al cambio de actitud cuando se le exige.',8),
(1,'convivencia','2.9','Llegar tarde a clases durante el cambio de hora y entre clase y clase.',9),
(1,'convivencia','2.10','Desobedecer las órdenes que le imparten las personas que lo están formando.',10),
(1,'convivencia','2.11','Cometer alguna imprudencia con intencionalidad o daño dentro de las dependencias didácticas o pedagógicas de la Institución.',11),
(1,'convivencia','2.12','Rayar las paredes, murales, cuadros o artefactos de la institución que son de uso masivo y para el beneficio de la comunidad educativa.',12),
(1,'convivencia','2.13','Quedarse en los alrededores de la institución realizando actos indebidos como manifestaciones amorosas indecorosas.',13),
(1,'convivencia','2.14','Incumplir con los protocolos de bioseguridad establecidos a nivel Nacional para la mitigación de la pandemia del covid 19. Su reiteración en el llamado de atención lo convierte en falta grave.',14)
ON CONFLICT DO NOTHING;

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(1,'bullying','3.1','Poner sobrenombres o apodos a sus compañeros y demás miembros de la comunidad educativa.',1),
(1,'bullying','3.2','Hacer burlas o mofas en los actos públicos, las clases o cuando los docentes o compañeros hagan uso de la palabra en auditorios.',2),
(1,'bullying','3.3','Emplear vocabulario soez cuando se relaciona con algún compañero o miembro de la Comunidad educativa, sea en tono ofensivo o amigable.',3),
(1,'bullying','3.4','Practicar juegos bruscos y propiciar peleas durante el descanso o en cualquier momento de su permanencia en la Institución Educativa.',4),
(1,'bullying','3.5','La indisciplina permanente en clases y su constante interrupción por estar incomodando a sus compañeros, charlando, haciendo murmullos o usando artefactos electrónicos.',5),
(1,'bullying','3.6','Demostrar desinterés o resistencia al momento de la formación, charlando en las filas o haciendo caso omiso al requerimiento hecho por un adulto.',6),
(1,'bullying','3.7','Hacer demasiado alboroto cuando estén ingresando a sus salones de clase, perturbando el orden y el trabajo de otros grupos.',7),
(1,'bullying','3.8','Emplear de manera inadecuada el agua, harina, huevos, bombas con agua y cualquier elemento nocivo e inadecuado para festejar acontecimientos.',8),
(1,'bullying','3.9','Utilizar medios electrónicos o digitales, redes sociales y comunicación móvil para burlarse de algún compañero.',9)
ON CONFLICT DO NOTHING;

-- ── Catálogo de faltas — TIPO II ─────────────────────────────────────

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(2,'academica','1.1','Reincidir en la no presentación de tareas, trabajos, talleres y consultas.',1),
(2,'academica','1.2','Presentar bajo resultado académico en la presentación de los exámenes y pruebas.',2),
(2,'academica','1.3','Obtener desempeño BAJO al finalizar un periodo en dos o más áreas reportadas en el boletín o informe periódico.',3),
(2,'academica','1.4','Reincidir en cada periodo con la reprobación de áreas sin demostrar mejoras en su rendimiento académico.',4),
(2,'academica','1.5','No asistir a una clase encontrándose dentro de la Institución Educativa, evadiéndose de clase sin presentar justificación.',5),
(2,'academica','1.6','La desaplicación absoluta y su falta de interés demostrado en sus estudios con los resultados académicos internos y externos (Fallo Corte Constitucional T-534 de 1994).',6),
(2,'academica','1.7','Inducir a otros compañeros con su actitud de bajo rendimiento académico a no presentar interés de cambio ni mejora.',7),
(2,'academica','1.8','Presentar desinterés permanente por el estudio aun teniendo capacidades cognitivas y desmejorando progresivamente sus resultados periódicos.',8),
(2,'academica','1.9','Hacer fraude, plagio o participar de él en sus evaluaciones o trabajos.',9)
ON CONFLICT DO NOTHING;

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(2,'convivencia','2.1','Cumplir 5 llegadas tarde a la Institución sin justificación reportadas en el control de asistencia y ser notificado de antemano.',1),
(2,'convivencia','2.2','Reincidir por tres veces en informes asumidos como situaciones tipo I o faltas leves demostrando así poco interés de cambio.',2),
(2,'convivencia','2.3','Salir de la Institución Educativa durante la jornada escolar por medios o formas indebidas.',3),
(2,'convivencia','2.4','Resistencia a los procesos disciplinarios y académicos de la Institución Educativa.',4),
(2,'convivencia','2.5','Faltar a los deberes como estudiante, consignados en el Manual de Convivencia.',5),
(2,'convivencia','2.6','Toda falta contra la ética y la moral que atente por el bienestar general sobre el particular.',6),
(2,'convivencia','2.7','Salir de su casa para la Institución y no presentarse a estudiar, comprobado con las llamadas que a diario hace la coordinación en el control de ausencias.',7),
(2,'convivencia','2.8','No presentarse a la Institución Educativa durante más de 3 días (hábiles, calendario) sin justificar debidamente su falta.',8),
(2,'convivencia','2.9','Consumir alguna bebida embriagante o llegar a la institución bajo los efectos del alcohol.',9),
(2,'convivencia','2.10','Encubrir las faltas cometidas por sus compañeros o entorpecer las investigaciones necesarias que emprenda la coordinación.',10),
(2,'convivencia','2.11','Negarse a cumplir con una acción disuasiva o correctiva recomendada o alguna sanción impuesta por el comité de convivencia escolar.',11),
(2,'convivencia','2.12','Ausentarse de la Institución antes de la hora oficial de salida, sin permiso previo, con engaños a coordinadores y vigilantes.',12),
(2,'convivencia','2.13','Practicar actividades contra la moral, las buenas costumbres o inducir a los demás a practicarlas; por ejemplo: fotografías obscenas, revistas, juegos y pasatiempos pornográficos.',13),
(2,'convivencia','2.14','Ocasionar daños a muebles y enseres de la institución, así como a los de sus compañeros y demás personal que labora en ella.',14),
(2,'convivencia','2.15','Mentira comprobada para justificar comportamientos anormales, demostrando falta de sinceridad con sus padres, docentes o directivos de la Institución Educativa.',15)
ON CONFLICT DO NOTHING;

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(2,'bullying','3.1','Agresividad en el trato verbal con compañeros, docentes, directivos, administrativos, personal operativo y Comunidad Educativa en general.',1),
(2,'bullying','3.2','Agresiones de palabra o de hecho, proferir insultos a los educadores, compañeros o personal de la Institución dentro o fuera de ella en relación con aspectos académicos o disciplinarios.',2),
(2,'bullying','3.3','Agredir físicamente a una persona generando daños en su cuerpo o afectando su salud mental o psicológica tomándose justicia por su propia cuenta.',3),
(2,'bullying','3.4','Actuar solapadamente entre su grupo, para indisponer a sus compañeros con determinados docentes para que no sean aceptadas sus clases.',4),
(2,'bullying','3.5','Generar una mala influencia a sus compañeros con sus comportamientos inadecuados afectando su estado de ánimo con el mal ejemplo y cambio de vida negativa.',5),
(2,'bullying','3.6','Escribir en los muros, en las puertas y paredes de la Institución Educativa o rayar los pupitres de los salones con frases o figuras que inciten a la violencia escolar.',6),
(2,'bullying','3.7','Participar o estimular a otras personas para que propicien actos que atenten contra la disciplina y la buena marcha de la Institución Educativa.',7),
(2,'bullying','3.8','Tomar decisiones que alteren el orden, reservadas a los docentes o directivas de la Institución, movilizando a otros en contra de la vida institucional afectando la convivencia.',8),
(2,'bullying','3.9','Faltar al respeto a compañeros, docentes o directivos ya sea con palabras, hechos o actos que atenten contra la sana convivencia.',9),
(2,'bullying','3.10','Distribuir por las redes sociales, en medios extraíbles o disposiciones móviles archivos digitales con drogas auditivas o visuales a sus compañeros o demás personas.',10),
(2,'bullying','3.11','Hacer uso inadecuado de las TIC para atentar contra el buen nombre de una persona o de la institución, a través de las redes sociales, los celulares y demás medios de comunicación masiva.',11),
(2,'bullying','3.12','Utilizar con frecuencia los medios de comunicación masiva para difamar el nombre de una persona o de la institución a través de correos electrónicos con fotografías, mensajes o textos alusivos al maltrato psicológico.',12)
ON CONFLICT DO NOTHING;

-- ── Catálogo de faltas — TIPO III ────────────────────────────────────

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(3,'academica','1.1','Alterar notas y dañar los observadores, anecdotarios, informes de valoraciones y falsificar las firmas en otros documentos oficiales de propiedad de los docentes y protocolos de la ruta de atención integral para la convivencia escolar.',1),
(3,'academica','1.2','Hacer fraude electrónico, virtual o presencial en cualquier área del plan de estudios.',2),
(3,'academica','1.3','No ser promovido al grado siguiente al terminar el año lectivo, por incurrir en causales de no promoción dispuestas en el SIEE.',3),
(3,'academica','1.4','No presentarse a las actividades programadas como estrategias pedagógicas de apoyo al estudiante, al terminar el año lectivo como lo exige el SIEE.',4),
(3,'academica','1.5','Asistir a las instalaciones de la institución y no presentarse ante los docentes para resolver sus cosas pendientes al terminar el año lectivo.',5),
(3,'academica','1.6','Comprobar que, con su actitud de bajo rendimiento escolar, haya inducido a sus compañeros a desmejorar sus resultados finales.',6),
(3,'academica','1.7','Inscribirse previamente para asistir a los exámenes anuales de las pruebas SABER y no presentarse el día de la citación, afectando a la institución con su inasistencia.',7),
(3,'academica','1.8','Acogerse a programas de mejora continua a través de las estrategias pedagógicas de apoyo al estudiante, y no presentarse a ellas o incidir en compañeros para que tampoco asistan.',8),
(3,'academica','1.9','Promover el soborno o la coacción a docentes de las áreas que lo atienden para beneficio de sus notas, previa comprobación de los hechos.',9)
ON CONFLICT DO NOTHING;

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(3,'convivencia','2.1','Reincidir con 3 faltas graves en su debido proceso registrado en los documentos de seguimiento de la coordinación, serán considerados sus actos como una falta gravísima.',1),
(3,'convivencia','2.2','Cualquier causa que ocasione intervención penal judicial, reclusión en una cárcel o casa de menores de edad, o juicio condenatorio por haber cometido delitos dentro y fuera de la Institución Educativa.',2),
(3,'convivencia','2.3','Incumplimiento por negligencia de lo acordado en el compromiso pedagógico, matrícula en observación o en el compromiso personal presentado por escrito a los Directivos de la Institución Educativa.',3),
(3,'convivencia','2.4','El hurto comprobado y todo atentado contra la propiedad privada de sus compañeros o personas de la institución.',4),
(3,'convivencia','2.5','Consumir alucinógenos o sustancias psicoactivas en la Institución o en sus alrededores afectando la imagen institucional.',5),
(3,'convivencia','2.6','Portar, guardar, o distribuir drogas, estupefacientes, hierbas con efectos alucinógenos, pepas, bebidas embriagantes y sustancias psicoactivas en la institución.',6),
(3,'convivencia','2.7','Violentar puertas, cerraduras, candados y demás instancias que requieren de seguridad en las diferentes dependencias de la Institución Educativa.',7),
(3,'convivencia','2.8','Portar armas de fuego, corto punzantes o blancas, de fabricación casera o instrumentos artefactos que pueden ser utilizados como un arma de manera clandestina y ser sorprendido con ellas.',8),
(3,'convivencia','2.9','Frecuentar páginas web de cine XXX, casas de juego, casas de citas, moteles o sitios similares, donde se atente contra la moral y las buenas costumbres de los menores, usando el uniforme o sin él.',9),
(3,'convivencia','2.10','Tener encuentros íntimos en los baños, unidades sanitarias u otras dependencias de la Institución Educativa.',10),
(3,'convivencia','2.11','Ser sancionado por el comité de convivencia escolar, según los pasos del debido proceso enmarcados en la ruta de atención integral para la convivencia escolar.',11)
ON CONFLICT DO NOTHING;

INSERT INTO raice_faltas_catalogo (tipo, categoria, numeral, descripcion, orden) VALUES
(3,'bullying','3.1','Utilizar pólvora detonante, sustancias químicas y otros elementos peligrosos dentro de la institución que atenten contra la integridad física de la comunidad y el establecimiento.',1),
(3,'bullying','3.2','Todo acto de intimidación, amenaza, chantaje o soborno contra cualquier miembro de la Comunidad Educativa (Art. 2 del Manual de Convivencia).',2),
(3,'bullying','3.3','Generar peleas o actos indebidos en la Institución Educativa o en la calle, transporte público o transporte escolar, usando el uniforme o identificándose como estudiante de la Institución, motivando encuentros de choque entre pandillas.',3),
(3,'bullying','3.4','Utilizar el nombre de la Institución Educativa sin autorización para hacer rifas, bingos, paseos, agasajos, colectas, ventas o actividades similares que involucren el manejo de dineros.',4),
(3,'bullying','3.5','Hacerse justicia por sí mismo agrediendo a sus compañeros, desconociendo la autoridad de la Institución Educativa y el conducto regular establecido en este Manual de Convivencia.',5),
(3,'bullying','3.6','Portar elementos que puedan ser utilizados contra la integridad física de las personas o del plantel, como armas de fuego, de balines o armas blancas corto-punzantes.',6),
(3,'bullying','3.7','Deslealtad con la Institución Educativa demostrada en el desinterés para participar en las diferentes actividades que programa la Institución Educativa, comentarios negativos comprobados contra el buen nombre de la Institución Educativa o de los docentes.',7),
(3,'bullying','3.8','Presentarse a la Institución Educativa embriagado o bajo los efectos de la droga o sustancias alucinógenas, pepas estupefacientes y sustancias psicoactivas de manera recurrente o por primera vez.',8),
(3,'bullying','3.9','Quedarse en los alrededores de la institución realizando actos indebidos como venta, compra o consumo de sustancias psicoactivas o complicidad en actos delictivos.',9),
(3,'bullying','3.10','Todo acto de Acoso escolar o bullying y/o ciberacoso por ser una conducta negativa, intencional, metódica y sistemática de agresión y por conllevar a la intimidación, humillación, ridiculización, difamación, coacción, aislamiento deliberado, amenaza o incitación a la violencia o cualquier forma de maltrato psicológico, verbal, físico o por medios electrónicos contra un niño, niña o adolescente.',10)
ON CONFLICT DO NOTHING;


-- ── Sede principal por defecto ──────────────────────────────────────
INSERT INTO raice_sedes (id, name, type, active)
VALUES ('00000000-0000-0000-0000-000000000001', 'Sede Principal', 'mixta', true)
ON CONFLICT (id) DO NOTHING;

-- =====================================================================
-- SECCIÓN 7: VERIFICACIÓN FINAL
-- Muestra todas las tablas raice_ con su número de columnas
-- =====================================================================
SELECT
  table_name                                          AS tabla,
  (SELECT COUNT(*)
   FROM information_schema.columns c
   WHERE c.table_name  = t.table_name
     AND c.table_schema = 'public')                  AS columnas
FROM information_schema.tables t
WHERE table_schema = 'public'
  AND table_name   LIKE 'raice_%'
ORDER BY table_name;

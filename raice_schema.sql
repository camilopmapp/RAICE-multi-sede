-- ============================================================
-- RAICE — Ruta de Atención Integral para la Convivencia Escolar
-- Esquema completo de instalación desde cero
-- Versión: 2026-04 | Supabase / PostgreSQL
-- ============================================================
-- Ejecutar como superusuario en el SQL Editor de Supabase.
-- ¡ADVERTENCIA! Si ya existe la BD, este script borra y recrea
-- todas las tablas. No ejecutar en producción con datos.
-- ============================================================

-- ============================================================
-- 0. EXTENSIONES
-- ============================================================
CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid()


-- ============================================================
-- 1. raice_users  (Usuarios del sistema)
-- ============================================================
CREATE TABLE raice_users (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT        NOT NULL UNIQUE,
  first_name           TEXT        NOT NULL,
  last_name            TEXT        NOT NULL DEFAULT '',
  email                TEXT,
  role                 TEXT        NOT NULL CHECK (role IN ('superadmin','admin','teacher','rector')),
  subject              TEXT,
  password_hash        TEXT        NOT NULL,
  active               BOOLEAN     NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN     NOT NULL DEFAULT FALSE,
  last_login           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_role     ON raice_users (role);
CREATE INDEX idx_users_active   ON raice_users (active);


-- ============================================================
-- 2. raice_courses  (Cursos / grupos)
-- ============================================================
CREATE TABLE raice_courses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  grade       INTEGER     NOT NULL,
  number      INTEGER     NOT NULL,
  section     TEXT,
  director_id UUID        REFERENCES raice_users (id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (grade, number)
);

CREATE INDEX idx_courses_grade ON raice_courses (grade);


-- ============================================================
-- 3. raice_teacher_courses  (Asignación docente-curso)
-- ============================================================
CREATE TABLE raice_teacher_courses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id  UUID        NOT NULL REFERENCES raice_users   (id) ON DELETE CASCADE,
  course_id   UUID        NOT NULL REFERENCES raice_courses (id) ON DELETE CASCADE,
  subject     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (teacher_id, course_id, subject)
);

CREATE INDEX idx_tc_teacher ON raice_teacher_courses (teacher_id);
CREATE INDEX idx_tc_course  ON raice_teacher_courses (course_id);


-- ============================================================
-- 4. raice_students  (Estudiantes)
-- ============================================================
CREATE TABLE raice_students (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  TEXT        NOT NULL,
  last_name   TEXT        NOT NULL,
  grade       INTEGER     NOT NULL,
  course      INTEGER     NOT NULL,
  course_id   UUID        REFERENCES raice_courses (id) ON DELETE SET NULL,
  code        TEXT        UNIQUE,
  email       TEXT,
  doc_type    TEXT        NOT NULL DEFAULT 'TI',
  doc_number  TEXT,
  birth_date  DATE,
  phone       TEXT,
  notes       TEXT,
  status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','transferred','retired','graduated')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_students_course_id ON raice_students (course_id);
CREATE INDEX idx_students_grade     ON raice_students (grade);
CREATE INDEX idx_students_status    ON raice_students (status);


-- ============================================================
-- 5. raice_attendance  (Registros de asistencia)
-- ============================================================
CREATE TABLE raice_attendance (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID        NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  course_id      UUID        NOT NULL REFERENCES raice_courses  (id) ON DELETE CASCADE,
  teacher_id     UUID        REFERENCES raice_users (id) ON DELETE SET NULL,
  date           DATE        NOT NULL,
  class_hour     INTEGER     NOT NULL DEFAULT 1 CHECK (class_hour BETWEEN 1 AND 12),
  status         TEXT        NOT NULL DEFAULT 'P'
                   CHECK (status IN ('P','A','PE','T','S','NR')),
                   -- P=Presente, A=Ausente, PE=Permiso, T=Tardanza, S=Sin registro (actividad especial)
  activity_note  TEXT,       -- Descripción de la actividad especial (cuando status='S')
  corrected_by   UUID        REFERENCES raice_users (id) ON DELETE SET NULL,
  corrected_at   TIMESTAMPTZ,
  correction_reason TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, date, course_id, class_hour)
);

CREATE INDEX idx_att_date         ON raice_attendance (date);
CREATE INDEX idx_att_course       ON raice_attendance (course_id);
CREATE INDEX idx_att_student      ON raice_attendance (student_id);
CREATE INDEX idx_att_student_date ON raice_attendance (student_id, date);
CREATE INDEX idx_att_course_date  ON raice_attendance (course_id, date, class_hour);


-- ============================================================
-- 6. raice_schedules  (Horario de clases por docente-curso)
-- ============================================================
CREATE TABLE raice_schedules (
  id                UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_course_id UUID    NOT NULL REFERENCES raice_teacher_courses (id) ON DELETE CASCADE,
  day_of_week       INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
                    -- 1=Lunes … 5=Viernes, 6=Sábado, 7=Domingo
  class_hour        INTEGER NOT NULL CHECK (class_hour BETWEEN 1 AND 12),
  start_time        TIME,
  end_time          TIME,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (teacher_course_id, day_of_week, class_hour)
);

CREATE INDEX idx_schedules_tc ON raice_schedules (teacher_course_id);


-- ============================================================
-- 7. raice_bell_schedule  (Timbre / horario de horas)
-- ============================================================
CREATE TABLE raice_bell_schedule (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  class_hour INTEGER NOT NULL UNIQUE CHECK (class_hour BETWEEN 1 AND 12),
  start_time TIME    NOT NULL,
  end_time   TIME    NOT NULL,
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================
-- 8. raice_periods  (Períodos académicos)
-- ============================================================
CREATE TABLE raice_periods (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  year        INTEGER     NOT NULL,
  period_num  INTEGER     NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (year, period_num)
);

CREATE INDEX idx_periods_active ON raice_periods (active, year);


-- ============================================================
-- 9. raice_calendar  (Calendario escolar)
-- ============================================================
CREATE TABLE raice_calendar (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE        NOT NULL,
  name       TEXT        NOT NULL,
  type       TEXT        NOT NULL DEFAULT 'holiday'
               CHECK (type IN ('holiday','vacation','institutional_day',
                               'teacher_meeting','union_day','event','exam','other')),
  year       INTEGER     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (date, type)
);

CREATE INDEX idx_calendar_year ON raice_calendar (year, date);


-- ============================================================
-- 10. raice_faltas_catalogo  (Catálogo de faltas del manual)
-- ============================================================
CREATE TABLE raice_faltas_catalogo (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        INTEGER NOT NULL CHECK (tipo IN (1,2,3)),
  categoria   TEXT    NOT NULL CHECK (categoria IN ('academica','convivencia','bullying')),
  numeral     TEXT    NOT NULL,
  descripcion TEXT    NOT NULL,
  activa      BOOLEAN NOT NULL DEFAULT TRUE,
  orden       INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_falta_tipo_cat_num UNIQUE (tipo, categoria, numeral)
);

CREATE INDEX idx_faltas_tipo      ON raice_faltas_catalogo (tipo, activa);
CREATE INDEX idx_faltas_categoria ON raice_faltas_catalogo (categoria);


-- ============================================================
-- 11. raice_cases  (Casos de convivencia)
-- ============================================================
CREATE TABLE raice_cases (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID        REFERENCES raice_students (id) ON DELETE SET NULL,
  student_name      TEXT        NOT NULL,
  grade             INTEGER,
  course            INTEGER,
  course_id         UUID        REFERENCES raice_courses (id) ON DELETE SET NULL,
  teacher_id        UUID        REFERENCES raice_users   (id) ON DELETE SET NULL,
  type              INTEGER     NOT NULL CHECK (type IN (1,2,3)),
  description       TEXT        NOT NULL,
  actions_taken     TEXT,
  notes             TEXT,
  status            TEXT        NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','tracking','closed')),
  closed_at         TIMESTAMPTZ,
  closed_by         UUID        REFERENCES raice_users (id) ON DELETE SET NULL,
  falta_id          UUID        REFERENCES raice_faltas_catalogo (id) ON DELETE SET NULL,
  falta_numeral     TEXT,
  falta_descripcion TEXT,
  falta_categoria   TEXT,
  otros_involucrados TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cases_student ON raice_cases (student_id);
CREATE INDEX idx_cases_teacher ON raice_cases (teacher_id);
CREATE INDEX idx_cases_status  ON raice_cases (status);


-- ============================================================
-- 12. raice_tipo1_escalones  (Escalones del proceso Tipo I)
-- ============================================================
CREATE TABLE raice_tipo1_escalones (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id          UUID    NOT NULL REFERENCES raice_cases (id) ON DELETE CASCADE,
  numero_escalon   INTEGER NOT NULL CHECK (numero_escalon BETWEEN 1 AND 4),
  tipo_llamado     TEXT    NOT NULL
                     CHECK (tipo_llamado IN ('verbal','escrito',
                                            'escrito_con_mediador','citacion_acudiente')),
  descripcion      TEXT    NOT NULL,
  descargos        TEXT,
  compromiso       TEXT,
  compromiso_fecha DATE,
  garante          TEXT,
  created_by       UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_escalones_case ON raice_tipo1_escalones (case_id, numero_escalon);


-- ============================================================
-- 13. raice_followups  (Seguimientos de casos)
-- ============================================================
CREATE TABLE raice_followups (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id         UUID    NOT NULL REFERENCES raice_cases (id) ON DELETE CASCADE,
  coordinator_id  UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  actions         TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'tracking'
                    CHECK (status IN ('tracking','closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_followups_case ON raice_followups (case_id);


-- ============================================================
-- 14. raice_observations  (Observaciones de estudiantes)
-- ============================================================
CREATE TABLE raice_observations (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID    NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  teacher_id  UUID    REFERENCES raice_users  (id) ON DELETE SET NULL,
  course_id   UUID    REFERENCES raice_courses (id) ON DELETE SET NULL,
  type        TEXT    NOT NULL DEFAULT 'neutral'
                CHECK (type IN ('positive','neutral','negative')),
  text        TEXT    NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_obs_student ON raice_observations (student_id, created_at DESC);


-- ============================================================
-- 15. raice_commitments  (Compromisos de estudiantes)
-- ============================================================
CREATE TABLE raice_commitments (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      UUID    REFERENCES raice_cases    (id) ON DELETE SET NULL,
  student_id   UUID    REFERENCES raice_students (id) ON DELETE SET NULL,
  description  TEXT    NOT NULL,
  signed_by    TEXT    NOT NULL DEFAULT '',
  due_date     DATE,
  fulfilled    BOOLEAN NOT NULL DEFAULT FALSE,
  fulfilled_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commitments_student ON raice_commitments (student_id);
CREATE INDEX idx_commitments_due     ON raice_commitments (due_date, fulfilled);


-- ============================================================
-- 16. raice_citations  (Citaciones a acudientes)
-- ============================================================
CREATE TABLE raice_citations (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID    REFERENCES raice_students (id) ON DELETE SET NULL,
  student_name   TEXT    NOT NULL,
  case_id        UUID    REFERENCES raice_cases (id) ON DELETE SET NULL,
  coordinator_id UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  reason         TEXT    NOT NULL,
  date_time      TIMESTAMPTZ,
  place          TEXT    NOT NULL DEFAULT 'Rectoría / Coordinación',
  attended       BOOLEAN NOT NULL DEFAULT FALSE,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_citations_student ON raice_citations (student_id);


-- ============================================================
-- 17. raice_suspensions  (Suspensiones de estudiantes)
-- ============================================================
CREATE TABLE raice_suspensions (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID    NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  coordinator_id  UUID    NOT NULL REFERENCES raice_users    (id) ON DELETE CASCADE,
  start_date      DATE    NOT NULL,
  end_date        DATE    NOT NULL,
  reason          TEXT    NOT NULL,
  case_id         UUID    REFERENCES raice_cases (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_suspensions_student ON raice_suspensions (student_id);
CREATE INDEX idx_suspensions_dates   ON raice_suspensions (start_date, end_date);


-- ============================================================
-- 18. raice_excusas  (Excusas / permisos de ausencia)
-- ============================================================
CREATE TABLE raice_excusas (
  id            UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    UUID      NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  course_id     UUID      NOT NULL REFERENCES raice_courses  (id) ON DELETE CASCADE,
  date          DATE      NOT NULL,
  motivo        TEXT      NOT NULL,
  horas         INTEGER[],   -- NULL = todo el día; array de horas específicas
  registered_by UUID      REFERENCES raice_users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (student_id, date)
);

CREATE INDEX idx_excusas_student ON raice_excusas (student_id, date);
CREATE INDEX idx_excusas_course  ON raice_excusas (course_id, date);
CREATE INDEX idx_excusas_horas   ON raice_excusas USING GIN (horas) WHERE horas IS NOT NULL;


-- ============================================================
-- 19. raice_classroom_removals  (Retiros de clase / aula)
-- ============================================================
CREATE TABLE raice_classroom_removals (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id   UUID    NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  teacher_id   UUID    NOT NULL REFERENCES raice_users    (id) ON DELETE CASCADE,
  course_id    UUID    NOT NULL REFERENCES raice_courses  (id) ON DELETE CASCADE,
  date         DATE    NOT NULL,
  class_hour   INTEGER,
  reason       TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','reviewed','case_opened')),
  reviewed_by  UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_removals_student ON raice_classroom_removals (student_id);
CREATE INDEX idx_removals_date    ON raice_classroom_removals (date, status);


-- ============================================================
-- 20. raice_teacher_absences  (Ausencias de docentes)
-- ============================================================
CREATE TABLE raice_teacher_absences (
  id              UUID      PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id      UUID      NOT NULL REFERENCES raice_users (id) ON DELETE CASCADE,
  date            DATE      NOT NULL,
  hours_absent    INTEGER[],   -- NULL = día completo
  reason          TEXT,
  registered_by   UUID      REFERENCES raice_users (id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_teacher_absences_teacher ON raice_teacher_absences (teacher_id);
CREATE INDEX idx_teacher_absences_date    ON raice_teacher_absences (date);


-- ============================================================
-- 21. raice_absence_replacements  (Reemplazos por ausencia docente)
-- ============================================================
CREATE TABLE raice_absence_replacements (
  id                     UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  absence_id             UUID    NOT NULL REFERENCES raice_teacher_absences (id) ON DELETE CASCADE,
  replacement_teacher_id UUID    NOT NULL REFERENCES raice_users            (id) ON DELETE CASCADE,
  class_hour             INTEGER,   -- NULL = día completo
  course_id              UUID    REFERENCES raice_courses (id) ON DELETE SET NULL,
  assigned_by            UUID    REFERENCES raice_users   (id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_absence_replacements_absence ON raice_absence_replacements (absence_id);


-- ============================================================
-- 22. raice_student_grade_history  (Historial de cambios de grado)
-- ============================================================
CREATE TABLE raice_student_grade_history (
  id              UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id      UUID    NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  from_grade      INTEGER NOT NULL,
  from_course     INTEGER NOT NULL,
  from_course_id  UUID    REFERENCES raice_courses (id) ON DELETE SET NULL,
  to_grade        INTEGER NOT NULL,
  to_course       INTEGER NOT NULL,
  to_course_id    UUID    REFERENCES raice_courses (id) ON DELETE SET NULL,
  reason          TEXT    NOT NULL DEFAULT 'correction'
                    CHECK (reason IN ('promotion','coexistence','correction','other')),
  notes           TEXT,
  changed_by      UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_grade_history_student    ON raice_student_grade_history (student_id, changed_at DESC);
CREATE INDEX idx_grade_history_changed_by ON raice_student_grade_history (changed_by);


-- ============================================================
-- 23. raice_acudientes  (Acceso portal acudientes)
-- ============================================================
CREATE TABLE raice_acudientes (
  id               UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID    NOT NULL REFERENCES raice_students (id) ON DELETE CASCADE,
  name             TEXT    NOT NULL,
  phone            TEXT,
  email            TEXT,
  relationship     TEXT    NOT NULL DEFAULT 'Acudiente',
  access_token     TEXT    NOT NULL UNIQUE,
  token_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_acudientes_student ON raice_acudientes (student_id);
CREATE INDEX idx_acudientes_token   ON raice_acudientes (access_token);


-- ============================================================
-- 24. raice_notifications  (Notificaciones internas)
-- ============================================================
CREATE TABLE raice_notifications (
  id           UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  to_user_id   UUID    NOT NULL REFERENCES raice_users (id) ON DELETE CASCADE,
  from_user_id UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  type         TEXT    NOT NULL,
                       -- 'evasion','evasion_confirmed','evasion_dismissed',
                       -- 'new_case','tardanza','classroom_removal'
  title        TEXT    NOT NULL,
  body         TEXT,
  link_id      UUID,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON raice_notifications (to_user_id, read, created_at DESC);


-- ============================================================
-- 25. raice_logs  (Bitácora de actividad)
-- ============================================================
CREATE TABLE raice_logs (
  id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID    REFERENCES raice_users (id) ON DELETE SET NULL,
  event_type  TEXT    NOT NULL,
  detail      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_logs_user       ON raice_logs (user_id, created_at DESC);
CREATE INDEX idx_logs_event_type ON raice_logs (event_type, created_at DESC);


-- ============================================================
-- 26. raice_config  (Configuración global del sistema)
-- ============================================================
CREATE TABLE raice_config (
  id                          INTEGER     PRIMARY KEY DEFAULT 1,
  school_name                 TEXT        NOT NULL DEFAULT 'Institución Educativa',
  location                    TEXT,
  dane_code                   TEXT,
  year                        TEXT        NOT NULL DEFAULT '2026',
  logo_url                    TEXT,
  num_periods                 INTEGER     NOT NULL DEFAULT 4,
  periods_config              JSONB,
  classes_per_day             INTEGER     NOT NULL DEFAULT 6,
  session_timeout             INTEGER     NOT NULL DEFAULT 60,
  correction_window           TEXT        NOT NULL DEFAULT 'class_duration'
                                CHECK (correction_window IN
                                  ('class_duration','same_day_end','custom_hour')),
  correction_window_minutes   INTEGER     NOT NULL DEFAULT 55,
  correction_window_hour      TEXT        DEFAULT '23:59',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT config_singleton CHECK (id = 1)
);

-- Fila única obligatoria
INSERT INTO raice_config (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;


-- ============================================================
-- SUPERADMIN INICIAL
-- ============================================================
-- Contraseña por defecto: "raice2026" (bcrypt hash)
-- CAMBIAR INMEDIATAMENTE tras el primer inicio de sesión.
INSERT INTO raice_users (username, first_name, last_name, role, password_hash, must_change_password)
VALUES (
  'superadmin',
  'Super',
  'Admin',
  'superadmin',
  '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', -- "password" bcrypt
  TRUE
)
ON CONFLICT (username) DO NOTHING;

-- ============================================================
-- NOTAS DE INSTALACIÓN
-- ============================================================
-- 1. Reemplazar el hash de contraseña del superadmin con uno generado
--    con bcryptjs: bcrypt.hashSync('tuContraseña', 10)
--
-- 2. Variables de entorno requeridas en .env.local:
--    SUPABASE_URL=https://xxxxx.supabase.co
--    SUPABASE_SERVICE_KEY=eyJ...  (service_role key, NO la anon key)
--    JWT_SECRET=cadena-aleatoria-larga
--
-- 3. En Supabase → Authentication → Providers:
--    Deshabilitar "Email" si no se usa autenticación nativa de Supabase.
--    RAICE usa su propio sistema de usuarios (raice_users).
--
-- 4. Para usar activity_note en raice_attendance, la columna ya está
--    incluida en este script. Si tienes una BD preexistente sin ella:
--    ALTER TABLE raice_attendance ADD COLUMN IF NOT EXISTS activity_note TEXT;
--
-- 5. Festivos y timbre: cargar manualmente desde el panel superadmin
--    (Calendario escolar y Horario de timbre).
-- ============================================================

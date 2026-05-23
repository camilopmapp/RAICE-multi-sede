-- ================================================================
-- RAICE — Esquema completo de base de datos Supabase
-- ================================================================
-- Ejecutar en: Supabase → SQL Editor
-- Versión: 3.0 | Generado: 2026-04-22
--
-- INSTRUCCIONES:
--   1. Abre el SQL Editor en tu proyecto de Supabase
--   2. Pega todo este archivo y ejecuta
--   3. Todas las tablas se crean con IF NOT EXISTS (seguro de re-ejecutar)
--   4. Al final se inserta la fila inicial de configuración
-- ================================================================


-- ================================================================
-- 1. USUARIOS (autenticación propia, sin Supabase Auth)
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_users (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  username             TEXT        NOT NULL UNIQUE,
  first_name           TEXT        NOT NULL,
  last_name            TEXT        NOT NULL,
  email                TEXT,
  role                 TEXT        NOT NULL DEFAULT 'teacher'
                                   CHECK (role IN ('superadmin','admin','rector','teacher')),
  subject              TEXT,
  password_hash        TEXT        NOT NULL,
  active               BOOLEAN     NOT NULL DEFAULT true,
  must_change_password BOOLEAN     NOT NULL DEFAULT false,
  last_login           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_users_username ON raice_users(username);
CREATE INDEX IF NOT EXISTS idx_raice_users_role     ON raice_users(role);


-- ================================================================
-- 2. CONFIGURACIÓN DEL COLEGIO (fila única id=1)
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_config (
  id                        INTEGER     PRIMARY KEY DEFAULT 1,
  school_name               TEXT,
  location                  TEXT,
  dane_code                 TEXT,
  year                      TEXT,
  num_periods               INTEGER     DEFAULT 4,
  periods_config            TEXT,       -- JSON serializado con rangos de período
  classes_per_day           INTEGER     DEFAULT 6,
  logo_url                  TEXT,
  correction_window         TEXT        DEFAULT 'same_day_end'
                                        CHECK (correction_window IN
                                          ('same_day_end','same_day_hour','class_duration','next_day_end')),
  correction_window_minutes INTEGER     DEFAULT 55,
  correction_window_hour    TEXT        DEFAULT '23:59',
  backup_email              TEXT,
  resend_api_key            TEXT,
  session_timeout           INTEGER     DEFAULT 60,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ================================================================
-- 3. CURSOS
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_courses (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  grade       INTEGER     NOT NULL,
  number      INTEGER     NOT NULL,
  section     TEXT,
  director_id UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_courses_grade ON raice_courses(grade);


-- ================================================================
-- 4. ESTUDIANTES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_students (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name  TEXT        NOT NULL,
  last_name   TEXT        NOT NULL,
  grade       INTEGER,
  course      INTEGER,
  course_id   UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  code        TEXT,
  email       TEXT,
  doc_type    TEXT,
  doc_number  TEXT,
  birth_date  DATE,
  notes       TEXT,
  status      TEXT        NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','inactive','retired','graduated')),
  phone       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_students_course_id ON raice_students(course_id);
CREATE INDEX IF NOT EXISTS idx_raice_students_status    ON raice_students(status);
CREATE INDEX IF NOT EXISTS idx_raice_students_last_name ON raice_students(last_name);


-- ================================================================
-- 5. ASIGNACIONES DOCENTE-CURSO
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_teacher_courses (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  course_id  UUID        NOT NULL REFERENCES raice_courses(id) ON DELETE CASCADE,
  subject    TEXT        NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_id, course_id, subject)
);

CREATE INDEX IF NOT EXISTS idx_raice_teacher_courses_teacher ON raice_teacher_courses(teacher_id);
CREATE INDEX IF NOT EXISTS idx_raice_teacher_courses_course  ON raice_teacher_courses(course_id);


-- ================================================================
-- 6. HORARIOS
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_schedules (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_course_id UUID        NOT NULL REFERENCES raice_teacher_courses(id) ON DELETE CASCADE,
  day_of_week       INTEGER     NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  class_hour        INTEGER     NOT NULL,
  start_time        TIME,
  end_time          TIME,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (teacher_course_id, day_of_week, class_hour)
);

CREATE INDEX IF NOT EXISTS idx_raice_schedules_tc_day ON raice_schedules(teacher_course_id, day_of_week);


-- ================================================================
-- 7. HORARIO DE CAMPANA (horas del día)
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_bell_schedule (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  class_hour INTEGER     NOT NULL UNIQUE,
  start_time TIME        NOT NULL,
  end_time   TIME        NOT NULL,
  label      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ================================================================
-- 8. ASISTENCIA
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_attendance (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  course_id         UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  teacher_id        UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  date              DATE        NOT NULL,
  class_hour        INTEGER     NOT NULL DEFAULT 1,
  status            TEXT        NOT NULL DEFAULT 'P'
                                CHECK (status IN ('P','A','T','PE','S','NR')),
  corrected_by      UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  corrected_at      TIMESTAMPTZ,
  correction_reason TEXT,
  activity_note     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, date, course_id, class_hour)
);

CREATE INDEX IF NOT EXISTS idx_raice_attendance_date       ON raice_attendance(date);
CREATE INDEX IF NOT EXISTS idx_raice_attendance_student    ON raice_attendance(student_id);
CREATE INDEX IF NOT EXISTS idx_raice_attendance_course     ON raice_attendance(course_id);
CREATE INDEX IF NOT EXISTS idx_raice_attendance_status     ON raice_attendance(status);
CREATE INDEX IF NOT EXISTS idx_raice_attendance_date_hour  ON raice_attendance(date, class_hour);


-- ================================================================
-- 9. EXCUSAS / PERMISOS
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_excusas (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id    UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  course_id     UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  date          DATE        NOT NULL,
  motivo        TEXT        NOT NULL,
  horas         INTEGER[],  -- NULL = todas las horas; array = horas específicas
  registered_by UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (student_id, date)
);

CREATE INDEX IF NOT EXISTS idx_raice_excusas_student ON raice_excusas(student_id);
CREATE INDEX IF NOT EXISTS idx_raice_excusas_date    ON raice_excusas(date);


-- ================================================================
-- 10. SUSPENSIONES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_suspensions (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  reason      TEXT,
  created_by  UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_suspensions_student ON raice_suspensions(student_id);
CREATE INDEX IF NOT EXISTS idx_raice_suspensions_dates   ON raice_suspensions(start_date, end_date);


-- ================================================================
-- 11. RETIROS DE CLASE
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_classroom_removals (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id  UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  teacher_id  UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  course_id   UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  date        DATE        NOT NULL,
  class_hour  INTEGER,
  reason      TEXT        NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending','reviewed')),
  reviewed_by UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_removals_student ON raice_classroom_removals(student_id);
CREATE INDEX IF NOT EXISTS idx_raice_removals_date    ON raice_classroom_removals(date);


-- ================================================================
-- 12. CATÁLOGO DE FALTAS
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_faltas_catalogo (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tipo        INTEGER     NOT NULL CHECK (tipo IN (1,2,3)),
  categoria   TEXT        NOT NULL,
  numeral     TEXT        NOT NULL,
  descripcion TEXT        NOT NULL,
  activa      BOOLEAN     NOT NULL DEFAULT true,
  orden       INTEGER     DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_faltas_tipo ON raice_faltas_catalogo(tipo);


-- ================================================================
-- 13. CASOS RAICE (convivencia)
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_cases (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id        UUID        REFERENCES raice_students(id) ON DELETE SET NULL,
  student_name      TEXT        NOT NULL,
  grade             INTEGER,
  course            INTEGER,
  course_id         UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  teacher_id        UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  type              INTEGER     NOT NULL CHECK (type IN (1,2,3)),
  description       TEXT,
  actions_taken     TEXT,
  notes             TEXT,
  status            TEXT        NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','closed','archived')),
  closed_at         TIMESTAMPTZ,
  closed_by         UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  falta_id          UUID        REFERENCES raice_faltas_catalogo(id) ON DELETE SET NULL,
  falta_numeral     TEXT,
  falta_descripcion TEXT,
  falta_categoria   TEXT,
  otros_involucrados TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_cases_student ON raice_cases(student_id);
CREATE INDEX IF NOT EXISTS idx_raice_cases_status  ON raice_cases(status);
CREATE INDEX IF NOT EXISTS idx_raice_cases_teacher ON raice_cases(teacher_id);


-- ================================================================
-- 14. OBSERVACIONES DE ESTUDIANTES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_observations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  teacher_id UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  course_id  UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  type       TEXT        NOT NULL DEFAULT 'neutral'
                         CHECK (type IN ('positive','neutral','negative')),
  text       TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_observations_student ON raice_observations(student_id);


-- ================================================================
-- 15. ACUDIENTES / PADRES DE FAMILIA
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_acudientes (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id       UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  name             TEXT        NOT NULL,
  phone            TEXT,
  email            TEXT,
  relationship     TEXT,
  access_token     TEXT,
  token_expires_at TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_acudientes_student ON raice_acudientes(student_id);


-- ================================================================
-- 16. SEGUIMIENTOS DE CASOS (followups)
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_followups (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id              UUID        NOT NULL REFERENCES raice_cases(id) ON DELETE CASCADE,
  coordinator_id       UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  actions              TEXT,
  status               TEXT        NOT NULL DEFAULT 'tracking',
  descargos            TEXT,
  descargo_estudiante  TEXT,
  coordinator_name     TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_followups_case ON raice_followups(case_id);


-- ================================================================
-- 17. COMPROMISOS
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_commitments (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id     UUID        NOT NULL REFERENCES raice_cases(id) ON DELETE CASCADE,
  student_id  UUID        REFERENCES raice_students(id) ON DELETE SET NULL,
  description TEXT        NOT NULL,
  signed_by   TEXT,
  due_date    DATE,
  fulfilled   BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_commitments_case    ON raice_commitments(case_id);
CREATE INDEX IF NOT EXISTS idx_raice_commitments_student ON raice_commitments(student_id);


-- ================================================================
-- 18. CITACIONES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_citations (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id    UUID        NOT NULL REFERENCES raice_cases(id) ON DELETE CASCADE,
  student_id UUID        REFERENCES raice_students(id) ON DELETE SET NULL,
  reason     TEXT,
  date_time  TIMESTAMPTZ,
  place      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_citations_case ON raice_citations(case_id);


-- ================================================================
-- 19. ESCALONES TIPO I
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_tipo1_escalones (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id           UUID        NOT NULL REFERENCES raice_cases(id) ON DELETE CASCADE,
  numero_escalon    INTEGER     NOT NULL DEFAULT 1,
  tipo_llamado      TEXT        NOT NULL DEFAULT 'verbal'
                                CHECK (tipo_llamado IN ('verbal','escrito','citacion')),
  descripcion       TEXT,
  descargos         TEXT,
  compromiso        TEXT,
  compromiso_fecha  DATE,
  garante           TEXT,
  created_by        UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_tipo1_case ON raice_tipo1_escalones(case_id);


-- ================================================================
-- 20. PERÍODOS ACADÉMICOS
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_periods (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  year        INTEGER     NOT NULL,
  period_num  INTEGER     NOT NULL,
  active      BOOLEAN     NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ================================================================
-- 21. CALENDARIO ESCOLAR
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_calendar (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  date       DATE        NOT NULL,
  name       TEXT        NOT NULL,
  type       TEXT        NOT NULL DEFAULT 'holiday'
                         CHECK (type IN ('holiday','vacation','event')),
  year       INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (date, type)
);

CREATE INDEX IF NOT EXISTS idx_raice_calendar_date ON raice_calendar(date);


-- ================================================================
-- 22. NOTIFICACIONES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_notifications (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  to_user_id   UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  from_user_id UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  type         TEXT        NOT NULL,
  title        TEXT,
  body         TEXT,
  link_id      UUID,
  read         BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_notifications_user ON raice_notifications(to_user_id);
CREATE INDEX IF NOT EXISTS idx_raice_notifications_read ON raice_notifications(to_user_id, read);


-- ================================================================
-- 23. LOGS DE ACTIVIDAD
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_logs (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  event_type TEXT        NOT NULL,
  detail     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_logs_user       ON raice_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_raice_logs_event_type ON raice_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_raice_logs_created_at ON raice_logs(created_at DESC);


-- ================================================================
-- 24. AUSENCIAS DE DOCENTES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_teacher_absences (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  teacher_id     UUID        NOT NULL REFERENCES raice_users(id) ON DELETE CASCADE,
  date           DATE        NOT NULL,
  hours_absent   INTEGER[],
  reason         TEXT,
  registered_by  UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_teacher_absences_teacher ON raice_teacher_absences(teacher_id);
CREATE INDEX IF NOT EXISTS idx_raice_teacher_absences_date    ON raice_teacher_absences(date);


-- ================================================================
-- 25. REEMPLAZOS DE DOCENTES AUSENTES
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_absence_replacements (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  absence_id            UUID        NOT NULL REFERENCES raice_teacher_absences(id) ON DELETE CASCADE,
  replacement_teacher_id UUID       REFERENCES raice_users(id) ON DELETE SET NULL,
  course_id             UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  class_hour            INTEGER,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_replacements_absence ON raice_absence_replacements(absence_id);


-- ================================================================
-- 26. HISTORIAL DE CAMBIOS DE GRADO/CURSO
-- ================================================================
CREATE TABLE IF NOT EXISTS raice_student_grade_history (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id     UUID        NOT NULL REFERENCES raice_students(id) ON DELETE CASCADE,
  from_grade     INTEGER,
  from_course    INTEGER,
  from_course_id UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  to_grade       INTEGER,
  to_course      INTEGER,
  to_course_id   UUID        REFERENCES raice_courses(id) ON DELETE SET NULL,
  reason         TEXT,
  notes          TEXT,
  changed_by     UUID        REFERENCES raice_users(id) ON DELETE SET NULL,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_raice_grade_history_student ON raice_student_grade_history(student_id);


-- ================================================================
-- 27. TRIGGER: Limpiar PE al eliminar excusa
-- Garantiza que al borrar una excusa desde cualquier vía
-- (app o panel de Supabase), los PE de asistencia se borran solos.
-- ================================================================
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


-- ================================================================
-- 28. FILA INICIAL DE CONFIGURACIÓN
-- (solo se inserta si no existe — seguro de re-ejecutar)
-- ================================================================
INSERT INTO raice_config (id, school_name, location, year, num_periods, classes_per_day,
                          correction_window, correction_window_minutes, correction_window_hour,
                          session_timeout)
VALUES (1, 'Nombre del Colegio', 'Ciudad', EXTRACT(YEAR FROM now())::TEXT,
        4, 6, 'same_day_end', 55, '23:59', 60)
ON CONFLICT (id) DO NOTHING;

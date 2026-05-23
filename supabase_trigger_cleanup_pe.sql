-- ================================================================
-- TRIGGER: Limpiar registros PE de asistencia al eliminar excusa
-- ================================================================
-- Ejecutar este script en el SQL Editor de Supabase.
-- Garantiza que al borrar una excusa (desde cualquier vía, incluido
-- el panel de Supabase), los registros PE correspondientes en
-- raice_attendance se eliminen automáticamente.
-- ================================================================

CREATE OR REPLACE FUNCTION raice_cleanup_pe_on_excusa_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Si la excusa tenía horas específicas, solo eliminar esas horas
  IF OLD.horas IS NOT NULL AND array_length(OLD.horas, 1) > 0 THEN
    DELETE FROM raice_attendance
    WHERE student_id = OLD.student_id
      AND date       = OLD.date
      AND status     = 'PE'
      AND class_hour = ANY(OLD.horas::int[]);
  ELSE
    -- Sin horas específicas: eliminar todos los PE de ese estudiante en esa fecha
    DELETE FROM raice_attendance
    WHERE student_id = OLD.student_id
      AND date       = OLD.date
      AND status     = 'PE';
  END IF;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Eliminar el trigger si ya existía (para poder re-ejecutar el script)
DROP TRIGGER IF EXISTS trg_cleanup_pe_on_excusa_delete ON raice_excusas;

-- Crear el trigger BEFORE DELETE
CREATE TRIGGER trg_cleanup_pe_on_excusa_delete
  BEFORE DELETE ON raice_excusas
  FOR EACH ROW
  EXECUTE FUNCTION raice_cleanup_pe_on_excusa_delete();

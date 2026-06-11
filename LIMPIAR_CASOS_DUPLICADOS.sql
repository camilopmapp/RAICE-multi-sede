-- ─────────────────────────────────────────────────────────────────────
-- LIMPIEZA DE CASOS RAICE DUPLICADOS
-- Ejecutar en Supabase → SQL Editor
--
-- Elimina casos duplicados (mismo estudiante + tipo + descripción + día),
-- conservando el más antiguo de cada grupo (el original).
-- Los dependientes se limpian solos:
--   followups / tipo1_escalones  → ON DELETE CASCADE (se borran)
--   commitments/citations/suspensions → ON DELETE SET NULL (case_id → null)
--
-- Esperado: ~36 casos eliminados, ~105 conservados.
-- ─────────────────────────────────────────────────────────────────────

-- PASO 1 (OPCIONAL): PREVISUALIZAR qué casos se eliminarían.
-- Ejecuta SOLO esta consulta primero para revisar. NO borra nada.
SELECT student_name, type, LEFT(description, 50) AS descripcion,
       created_at::date AS fecha, id
FROM (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY student_id, type, description, created_at::date
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM raice_cases
) x
WHERE rn > 1
ORDER BY student_name, fecha;


-- PASO 2: ELIMINAR los duplicados (ejecuta esto cuando confirmes el preview).
WITH dups AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY student_id, type, description, created_at::date
           ORDER BY created_at ASC, id ASC
         ) AS rn
  FROM raice_cases
)
DELETE FROM raice_cases
WHERE id IN (SELECT id FROM dups WHERE rn > 1);


-- PASO 3 (OPCIONAL): verificar el total después de limpiar.
SELECT count(*) AS casos_restantes FROM raice_cases;

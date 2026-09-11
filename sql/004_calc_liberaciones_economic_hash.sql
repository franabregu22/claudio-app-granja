-- Función auxiliar: calcular hash económico para same-source comparison
-- Compara dos registros Liberaciones del mismo SOURCE_ID
-- Retorna hash SHA256 determinístico del estado económico

CREATE OR REPLACE FUNCTION calc_liberaciones_economic_hash(
  p_source_external_id VARCHAR,
  p_net_credit NUMERIC,
  p_net_debit NUMERIC,
  p_gross_amount NUMERIC,
  p_tax_amount NUMERIC,
  p_transaction_date TIMESTAMP WITH TIME ZONE,
  p_description VARCHAR,
  p_payment_method VARCHAR
) RETURNS VARCHAR(64) AS $$
DECLARE
  v_json_array JSONB;
  v_json_text TEXT;
  v_hash VARCHAR(64);
BEGIN
  -- Construir array JSON con valores económicos en orden determinístico
  v_json_array := jsonb_build_array(
    p_source_external_id,
    p_net_credit,
    p_net_debit,
    p_gross_amount,
    p_tax_amount,
    p_transaction_date,
    p_description,
    p_payment_method
  );

  -- Convertir a texto (determinístico)
  v_json_text := v_json_array::TEXT;

  -- Calcular SHA256
  v_hash := encode(digest(v_json_text, 'sha256'), 'hex');

  RETURN v_hash;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

COMMENT ON FUNCTION calc_liberaciones_economic_hash(VARCHAR, NUMERIC, NUMERIC, NUMERIC, NUMERIC, TIMESTAMP WITH TIME ZONE, VARCHAR, VARCHAR) IS
  'Calculate SHA256 hash of economic state for same-source Liberaciones record comparison. Used to detect economic changes when re-importing same SOURCE_ID.';

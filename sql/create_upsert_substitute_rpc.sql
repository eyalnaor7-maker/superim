-- Create custom RPC function to upsert substitutes from the Chrome Extension
-- This function runs with SECURITY DEFINER to bypass RLS write restrictions
-- safely for this specific operation.

CREATE OR REPLACE FUNCTION upsert_substitute(
    p_original_barcode text,
    p_substitute_barcode_1 text,
    p_substitute_barcode_2 text
)
RETURNS void
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO substitutes (original_barcode, substitute_barcode_1, substitute_barcode_2)
    VALUES (p_original_barcode, p_substitute_barcode_1, p_substitute_barcode_2)
    ON CONFLICT (original_barcode) 
    DO UPDATE SET
        substitute_barcode_1 = COALESCE(p_substitute_barcode_1, substitutes.substitute_barcode_1),
        substitute_barcode_2 = COALESCE(p_substitute_barcode_2, substitutes.substitute_barcode_2),
        created_at = now();
END;
$$ LANGUAGE plpgsql;

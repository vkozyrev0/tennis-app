-- CourtOps Tennis — constrain t-shirt size to the canonical 7 (design-critique).
-- First normalize existing values (codes + full forms) to the canonical labels,
-- null out anything still unrecognized so the CHECK can be added safely, then add
-- the constraint. App writes already normalize; this guards the column.

UPDATE tournament_entry SET t_shirt_size = CASE upper(regexp_replace(t_shirt_size, '[^A-Za-z]', '', 'g'))
    WHEN 'YS' THEN 'Youth Small'   WHEN 'YOUTHSMALL'  THEN 'Youth Small'
    WHEN 'YM' THEN 'Youth Medium'  WHEN 'YOUTHMEDIUM' THEN 'Youth Medium'
    WHEN 'YL' THEN 'Youth Large'   WHEN 'YOUTHLARGE'  THEN 'Youth Large'
    WHEN 'AS' THEN 'Adult Small'   WHEN 'ADULTSMALL'  THEN 'Adult Small'   WHEN 'S' THEN 'Adult Small'
    WHEN 'AM' THEN 'Adult Medium'  WHEN 'ADULTMEDIUM' THEN 'Adult Medium'  WHEN 'M' THEN 'Adult Medium'
    WHEN 'AL' THEN 'Adult Large'   WHEN 'ADULTLARGE'  THEN 'Adult Large'   WHEN 'L' THEN 'Adult Large'
    WHEN 'AXL' THEN 'Adult Extra Large'  WHEN 'AXXL' THEN 'Adult Extra Large'
    WHEN 'XL' THEN 'Adult Extra Large'   WHEN 'XXL'  THEN 'Adult Extra Large'
    WHEN 'XXXL' THEN 'Adult Extra Large' WHEN 'ADULTEXTRALARGE' THEN 'Adult Extra Large'
    ELSE t_shirt_size
END
WHERE t_shirt_size IS NOT NULL;

-- Anything still off-list becomes NULL (rather than blocking the constraint).
UPDATE tournament_entry SET t_shirt_size = NULL
WHERE t_shirt_size IS NOT NULL AND t_shirt_size NOT IN (
    'Youth Small', 'Youth Medium', 'Youth Large',
    'Adult Small', 'Adult Medium', 'Adult Large', 'Adult Extra Large');

ALTER TABLE tournament_entry ADD CONSTRAINT tournament_entry_tshirt_canon
    CHECK (t_shirt_size IS NULL OR t_shirt_size IN (
        'Youth Small', 'Youth Medium', 'Youth Large',
        'Adult Small', 'Adult Medium', 'Adult Large', 'Adult Extra Large'));

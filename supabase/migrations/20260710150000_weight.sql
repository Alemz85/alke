-- Body weight from Health Auto Export's weight_body_mass metric (scalar per
-- date, last-wins like resting_hr; always normalized to kg by the parser).
alter table daily_metrics add column weight_kg numeric;

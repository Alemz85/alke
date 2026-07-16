-- Daily protein target for the tracker (grams). Nullable — unset keeps the
-- pill/card on their self-relative framing (today vs the week's own average);
-- set, they show progress toward the target. The evidence-backed default the
-- Settings UI suggests (never auto-fills) is 1.6 g/kg body weight (see
-- knowledge/topics/protein-for-muscle.md — Morton 2018 plateau).
alter table user_config
  add column protein_target_g integer
    check (protein_target_g > 0 and protein_target_g < 400);

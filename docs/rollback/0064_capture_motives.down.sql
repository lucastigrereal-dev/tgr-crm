-- Desfaz 0064: só remove o que a 0064 criou. Rode apenas se nenhuma ficha usa os motivos (ntMotiveId / commercialOutcomeMotiveId).
ALTER TABLE `capture_records` DROP COLUMN `ntRecordedByUserId`;
ALTER TABLE `capture_records` DROP COLUMN `ntRecordedAt`;
ALTER TABLE `capture_records` DROP COLUMN `ntCaptorName`;
ALTER TABLE `capture_records` DROP COLUMN `ntComplement`;
ALTER TABLE `capture_records` DROP COLUMN `ntMotiveId`;
ALTER TABLE `capture_records` DROP COLUMN `ntKind`;
ALTER TABLE `capture_records` DROP COLUMN `commercialOutcomeComplement`;
ALTER TABLE `capture_records` DROP COLUMN `commercialOutcomeMotiveId`;
DROP TABLE `capture_motives`;
DELETE FROM __drizzle_migrations WHERE created_at = 1792261967301;

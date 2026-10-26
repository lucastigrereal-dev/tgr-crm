-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus e do dono do banco antes de virar migration real.
-- Ficha do captador v2 (decisao do Lucas, 26/10): o GuestPass passou a distinguir TOUR DIRETO (visita hoje, sem horario) de AGENDAMENTO e a pedir a idade do titular.
-- O CRM guarda so o que nao tinha casa: o tipo de visita e a idade do titular. O 2o telefone (do conjuge) vai em customer_contacts (tabela ja aplicada) e o carro em campo unico
-- ja cabe em capture_records.vehicleModel. Aditiva: 1 CREATE TABLE IF NOT EXISTS, sem backfill, nao altera customers nem capture_records. Atras de CAPTURE_FICHA_V2_ENABLED=false.
-- drizzle/schema.ts ja descreve a tabela (como capture_guestpass_links da 0087); o uso so existe com a flag ligada, depois desta migration aplicada.
-- ATENCAO: o rollback so pode ser usado em banco de TESTE ou SINTETICO. Rollback: DROP TABLE `capture_ficha_v2`;

CREATE TABLE IF NOT EXISTS `capture_ficha_v2` (
	`id` int AUTO_INCREMENT NOT NULL,
	`captureId` int NOT NULL,
	`visitMode` varchar(16),
	`holderAge` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_ficha_v2_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_ficha_v2_capture_unique` UNIQUE (`captureId`),
	CONSTRAINT `capture_ficha_v2_captureId_fk` FOREIGN KEY (`captureId`) REFERENCES `capture_records`(`id`),
	CONSTRAINT `capture_ficha_v2_mode_check` CHECK (`visitMode` IS NULL OR `visitMode` IN ('agendamento','tour_direto')),
	CONSTRAINT `capture_ficha_v2_age_check` CHECK (`holderAge` IS NULL OR (`holderAge` BETWEEN 0 AND 120))
);

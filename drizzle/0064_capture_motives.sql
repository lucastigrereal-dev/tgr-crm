CREATE TABLE `capture_motives` (
	`id` int AUTO_INCREMENT NOT NULL,
	`kind` enum('nt_perfil','nt_tempo','nt_consultor','nt_mesa','qualificacao') NOT NULL,
	`code` varchar(60) NOT NULL,
	`label` varchar(160) NOT NULL,
	`requiresComplement` boolean NOT NULL DEFAULT false,
	`sortOrder` int NOT NULL DEFAULT 0,
	`active` boolean NOT NULL DEFAULT true,
	`provisional` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_motives_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_motives_kind_code_unique` UNIQUE(`kind`,`code`)
);
--> statement-breakpoint
ALTER TABLE `capture_records` ADD `commercialOutcomeMotiveId` int;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `commercialOutcomeComplement` text;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `ntKind` enum('perfil','tempo','consultor');--> statement-breakpoint
ALTER TABLE `capture_records` ADD `ntMotiveId` int;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `ntComplement` text;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `ntCaptorName` varchar(180);--> statement-breakpoint
ALTER TABLE `capture_records` ADD `ntRecordedAt` timestamp;--> statement-breakpoint
ALTER TABLE `capture_records` ADD `ntRecordedByUserId` int;--> statement-breakpoint
INSERT IGNORE INTO `capture_motives` (`kind`, `code`, `label`, `requiresComplement`, `sortOrder`, `provisional`) VALUES
	('nt_perfil', 'idade', 'Idade fora do perfil', false, 10, true),
	('nt_perfil', 'estado_civil', 'Estado civil fora do perfil', false, 20, true),
	('nt_perfil', 'renda', 'Renda abaixo do mínimo', false, 30, true),
	('nt_perfil', 'sem_cartao', 'Sem cartão de crédito', false, 40, true),
	('nt_perfil', 'sem_casa', 'Sem casa própria', false, 50, true),
	('nt_perfil', 'veiculo', 'Veículo fora do perfil', false, 60, true),
	('nt_perfil', 'varios_itens', 'Mais de um item fora do perfil', false, 70, true),
	('nt_perfil', 'outro', 'Outro motivo de perfil', true, 99, true),
	('nt_tempo', 'sem_tempo', 'Casal sem tempo para a apresentação', false, 10, true),
	('nt_tempo', 'compromisso', 'Compromisso marcado no mesmo horário', false, 20, true),
	('nt_tempo', 'saiu_na_espera', 'Saiu durante a espera', false, 30, true),
	('nt_tempo', 'outro', 'Outro motivo de tempo', true, 99, true),
	('nt_consultor', 'sem_consultor', 'Sem consultor disponível', false, 10, true),
	('nt_consultor', 'desistiu_consultor', 'Casal recusou o consultor', false, 20, true),
	('nt_consultor', 'outro', 'Outro motivo de consultor', true, 99, true),
	('nt_mesa', 'sem_interesse', 'Sem interesse no produto', false, 10, true),
	('nt_mesa', 'preco', 'Valor acima do que o casal quer pagar', false, 20, true),
	('nt_mesa', 'vai_pensar', 'Quer pensar e voltar depois', false, 30, true),
	('nt_mesa', 'sem_aprovacao', 'Crédito ou cartão não aprovou', false, 40, true),
	('nt_mesa', 'um_decide', 'Um dos dois não decidiu', false, 50, true),
	('nt_mesa', 'outro', 'Outro motivo de mesa', true, 99, true),
	('qualificacao', 'dentro_perfil', 'Dentro do perfil', false, 10, true),
	('qualificacao', 'nq_aceito', 'Fora de um item, aceito pelo gerente', false, 20, true),
	('qualificacao', 'fora_perfil', 'Fora do perfil', false, 30, true),
	('qualificacao', 'outro', 'Outro motivo de qualificação', true, 99, true);

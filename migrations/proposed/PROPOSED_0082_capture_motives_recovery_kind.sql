-- PROPOSTA (NAO APLICADA, nao esta no journal do drizzle). Precisa de GO do Opus antes de virar migration real.
-- Item 8 das configuracoes do admin: catalogo UNICO de motivos NT/Recovery. O catalogo ja e unico (capture_motives, tela em /dicionarios, auditado); falta apenas o tipo `recovery`
-- para os motivos do Recovery morarem no mesmo lugar. Ampliar o ENUM e aditivo (valores existentes mantem a ordem). Sem seed: os textos sao decisao do Lucas.
-- NAO ligado: drizzle/schema.ts e a rota continuam sem `recovery` ate esta migration ser aplicada (o teste schemaDrift compara schema x banco aplicado).
-- Rollback: so seguro se nao houver linhas kind='recovery': ALTER TABLE capture_motives MODIFY COLUMN kind enum('nt_perfil','nt_tempo','nt_consultor','nt_mesa','qualificacao') NOT NULL;
ALTER TABLE `capture_motives` MODIFY COLUMN `kind` enum('nt_perfil','nt_tempo','nt_consultor','nt_mesa','qualificacao','recovery') NOT NULL;

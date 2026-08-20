const url = process.env.E2E_DATABASE_URL;
const productionUrl = process.env.DATABASE_URL;
if (!url) throw new Error("E2E_DATABASE_URL é obrigatória para E2E estrito.");
if (productionUrl && url === productionUrl) throw new Error("E2E_DATABASE_URL não pode apontar para o banco operacional.");
if (process.env.E2E_CONFIRM_ISOLATED !== "I_CONFIRM_ISOLATED_E2E") throw new Error("Defina E2E_CONFIRM_ISOLATED=I_CONFIRM_ISOLATED_E2E para autorizar fixtures descartáveis.");
const parsed = new URL(url); const database = parsed.pathname.replace(/^\//, "");
if (!/(?:_e2e|_test|_staging)$/i.test(database)) throw new Error("O banco de E2E deve terminar em _e2e, _test ou _staging.");
console.log(`Homologação isolada validada: ${parsed.hostname}/${database}`);

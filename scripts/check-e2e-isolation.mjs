import { assertIsolatedE2EEnvironment } from "./e2e-isolation-lib.mjs";

const isolation = assertIsolatedE2EEnvironment();
console.log(
  `Homologação isolada validada: ${isolation.hostname}:${isolation.port}/${isolation.database}`,
);

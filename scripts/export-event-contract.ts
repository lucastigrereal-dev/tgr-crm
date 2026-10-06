// Imprime o contrato de eventos do CRM (WP5). Uso: pnpm exec tsx scripts/export-event-contract.ts > shared/contracts/tgr-events.snapshot.json
import { exportEventContract } from "../server/eventContract";

process.stdout.write(JSON.stringify(exportEventContract(), null, 2) + "\n");

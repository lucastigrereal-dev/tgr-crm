import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { contractsRouter } from "./routers/contracts";
import { commissionsRouter } from "./routers/commissions";
import { campaignsRouter } from "./routers/campaigns";
import { ownershipRouter } from "./routers/ownership";
import { customersRouter } from "./routers/customers";
import { dashboardRouter } from "./routers/dashboard";
import { financeRouter } from "./routers/finance";
import { importsRouter } from "./routers/imports";
import { operationsRouter } from "./routers/operations";
import { salesRouter } from "./routers/sales";
import { teamRouter } from "./routers/team";
import { integrationsRouter } from "./routers/integrations";
import { aiRouter } from "./routers/ai";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  customers: customersRouter,
  sales: salesRouter,
  commissions: commissionsRouter,
  campaigns: campaignsRouter,
  ownership: ownershipRouter,
  contracts: contractsRouter,
  team: teamRouter,
  operations: operationsRouter,
  finance: financeRouter,
  dashboard: dashboardRouter,
  imports: importsRouter,
  integrations: integrationsRouter,
  ai: aiRouter,
});

export type AppRouter = typeof appRouter;

import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { LocalAuthError, authenticateLocalUser, localAuthStatus } from "./localAuth";
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
import { capturesRouter } from "./routers/captures";
import { projectSettingsRouter } from "./routers/projectSettings";
import { commercialPoliciesRouter } from "./routers/commercialPolicies";
import { intelligenceRouter } from "./routers/intelligence";
import { inventoryRouter } from "./routers/inventory";
import { monetaryAdjustmentsRouter } from "./routers/monetaryAdjustments";

export const appRouter = router({
    // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    localStatus: publicProcedure.query(() => localAuthStatus()),
    localLogin: publicProcedure
      .input(z.object({
        username: z.string().trim().min(1).max(64),
        password: z.string().min(1).max(256),
      }))
      .mutation(async ({ ctx, input }) => {
        const clientKey = ctx.req.ip || ctx.req.socket?.remoteAddress || "unknown";
        try {
          const user = await authenticateLocalUser(input, clientKey);
          const sessionToken = await sdk.createSessionToken(user.openId, {
            name: user.name || user.openId,
            expiresInMs: ONE_YEAR_MS,
          });
          const cookieOptions = getSessionCookieOptions(ctx.req);
          ctx.res.cookie(COOKIE_NAME, sessionToken, { ...cookieOptions, maxAge: ONE_YEAR_MS });
          return { success: true, user };
        } catch (error) {
          if (error instanceof LocalAuthError) {
            throw new TRPCError({
              code: error.code === "LOCKED" ? "TOO_MANY_REQUESTS" : "UNAUTHORIZED",
              message: error.message,
            });
          }
          throw error;
        }
      }),
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
  captures: capturesRouter,
  projectSettings: projectSettingsRouter,
  commercialPolicies: commercialPoliciesRouter,
  intelligence: intelligenceRouter,
  inventory: inventoryRouter,
  monetaryAdjustments: monetaryAdjustmentsRouter,
});

export type AppRouter = typeof appRouter;

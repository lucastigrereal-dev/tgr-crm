import { asc, eq } from "drizzle-orm";
import { salesCampaigns } from "../../drizzle/schema";
import { getDb } from "../db";
import { router } from "../_core/trpc";
import { salesProcedure } from "./access";

export const campaignsRouter = router({
  list: salesProcedure.query(async () => {
    const db = await getDb();
    if (!db) return { rows: [], truncated: false, truncatedSources: [] };
    const limit = 500;
    const rawRows = await db.select({ id: salesCampaigns.id, code: salesCampaigns.code, name: salesCampaigns.name, status: salesCampaigns.status })
      .from(salesCampaigns).where(eq(salesCampaigns.status, "active")).orderBy(asc(salesCampaigns.name)).limit(limit + 1);
    const truncated = rawRows.length > limit;
    return { rows: rawRows.slice(0, limit), truncated, truncatedSources: truncated ? ["campanhas ativas"] : [] };
  }),
});

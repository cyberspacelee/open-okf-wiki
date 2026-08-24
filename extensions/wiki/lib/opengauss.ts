import { Client } from "pg";
import {
  createCatalog,
  redactDatabaseUrl,
  type CatalogQuery,
  type WikiCatalog,
  type WikiCatalogConfig,
} from "./catalog.js";

async function withOpenGaussQuery<T>(url: string, run: (query: CatalogQuery) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = 10000");
    await client.query("SELECT opengauss_version()");
    const query: CatalogQuery = async (sql, params) => {
      const result = await client.query(sql, params);
      return result.rows as Record<string, unknown>[];
    };
    return await run(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`openGauss Catalog failed (${redactDatabaseUrl(url)}): ${redactDatabaseUrl(message)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function createOpenGaussCatalog(config: WikiCatalogConfig): WikiCatalog {
  return {
    config,
    async listTables(filter) {
      return await withOpenGaussQuery(config.url, async (query) => {
        return await createCatalog(config, query).listTables(filter);
      });
    },
    async describeTables(names) {
      return await withOpenGaussQuery(config.url, async (query) => {
        return await createCatalog(config, query).describeTables(names);
      });
    },
  };
}

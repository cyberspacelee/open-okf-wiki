import { Client } from "pg";
import {
  createCatalog,
  redactDatabaseUrl,
  type CatalogQuery,
  type WikiCatalog,
  type WikiDatabaseConfig,
} from "./catalog.js";

async function withPostgresQuery<T>(url: string, run: (query: CatalogQuery) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = 10000");
    const query: CatalogQuery = async (sql, params) => {
      const result = await client.query(sql, params);
      return result.rows as Record<string, unknown>[];
    };
    return await run(query);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Postgres Catalog failed (${redactDatabaseUrl(url)}): ${redactDatabaseUrl(message)}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export function createPostgresCatalog(config: WikiDatabaseConfig): WikiCatalog {
  return {
    config,
    async listTables(filter) {
      return await withPostgresQuery(config.url, async (query) => {
        return await createCatalog(config, query).listTables(filter);
      });
    },
    async describeTables(names) {
      return await withPostgresQuery(config.url, async (query) => {
        return await createCatalog(config, query).describeTables(names);
      });
    },
  };
}

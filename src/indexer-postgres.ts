import { postgresModelStore as makePostgresModelStore } from "./indexer/model-postgres.js"
// An explicit binding avoids a Bun CJS re-export getter referring to a missing import.
export const postgresModelStore: typeof makePostgresModelStore = makePostgresModelStore
export type { PostgresDatabase, PostgresTransaction } from "./indexer/model-postgres.js"

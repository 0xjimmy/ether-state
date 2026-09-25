import { d1Store as makeStore } from "./indexer/d1.js"
export const d1Store: typeof makeStore = makeStore
export type { D1Database, D1PreparedStatement, D1Result } from "./indexer/d1.js"
export type { IndexStoreError } from "./indexer/storage.js"

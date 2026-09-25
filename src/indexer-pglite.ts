import { pgliteStore as makeStore } from "./indexer/pglite.js"
export const pgliteStore: typeof makeStore = makeStore
export type { PGliteDatabase, PGliteResult, PGliteTransaction } from "./indexer/pglite.js"
export type { IndexStoreError } from "./indexer/storage.js"

import { pgliteModelStore as makeModelStore } from "./indexer/model-pglite.js"
export const pgliteModelStore: typeof makeModelStore = makeModelStore

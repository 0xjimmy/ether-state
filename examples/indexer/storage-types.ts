import { PGlite } from "@electric-sql/pglite"
import { createClient } from "@libsql/client"
import type { D1Database } from "@cloudflare/workers-types"
import { d1Store } from "../../src/indexer-d1.js"
import { libsqlStore } from "../../src/indexer-libsql.js"
import { pgliteStore } from "../../src/indexer-pglite.js"

const postgres = new PGlite()
const sqlite = createClient({ url: "file::memory:" })
declare const d1: D1Database

void pgliteStore(postgres)
void libsqlStore(sqlite)
void d1Store(d1)

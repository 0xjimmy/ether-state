import type { Scope } from "effect"
import { Effect, Schema } from "effect"
import { Indexer, Projection, Source } from "ether-state/indexer"
import type { ModelFailure, ProjectionUpdate } from "ether-state/indexer"
import type { EvmClient } from "ether-state"

// Compile-only fixture: callers infer parameter and projection types from the definition.
const Definition = Indexer.define({
	name: "typed-example", version: 1, params: Schema.Struct({ address: Schema.String }),
	build: ({ params }) => {
		const source = Source.logs({ name: "events", filter: { address: params.address }, schema: Schema.Number,
			decode: () => Effect.succeed(1) })
		return { count: Projection.state({ source, schema: Schema.Number, seed: () => Effect.succeed(0),
			reduce: ({ state, events }) => Effect.succeed(state + events.length) }) }
	},
})
const types: (client: EvmClient) => Effect.Effect<readonly ProjectionUpdate<number>[], ModelFailure, Scope.Scope> = (client) => Effect.gen(function* () {
	const instance = yield* Definition.make({ client, params: { address: "0x" }, plan: { live: { start: "head" } } })
	const rows: Effect.Effect<readonly ProjectionUpdate<number>[], ModelFailure> = instance.read("count")
	// @ts-expect-error Projection names are checked.
	instance.read("unknown")
	// @ts-expect-error Instance parameters are checked.
	Definition.make({ client, params: { address: 1 }, plan: { live: { start: "head" } } })
	return yield* rows
})
export { types }

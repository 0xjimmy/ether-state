import { Effect } from "effect"
import { EvmClient } from "ether-state"
import { PoolIndex } from "./pool-definition.js"
import { runExample } from "./run-example.js"

// A finite job has no live worker. Its run Effect returns after the range commits.
await runExample(Effect.gen(function* () {
	const client = yield* EvmClient.make({ network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "8453") } })
	const head = yield* client.getBlock()
	const through = BigInt(process.env["END_BLOCK"] ?? head.number)
	const from = BigInt(process.env["START_BLOCK"] ?? (through > 20n ? through - 20n : 0n))
	const pool = yield* PoolIndex.make({ client,
		params: { address: process.env["POOL"] ?? "0x6c561B446416E1A00E8E93E221854d6eA4171372" },
		plan: { history: { from, through, direction: "forward", batchSize: 8 } },
	})
	yield* pool.run()
	yield* Effect.log("Stored candles", yield* pool.read("candles"))
	yield* Effect.log("Coverage", yield* pool.status)
}))

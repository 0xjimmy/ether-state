import { Effect, Stream } from "effect"
import { EvmClient } from "ether-state"
import { PoolIndex } from "./pool-definition.js"
import { runExample } from "./run-example.js"

// One definition can create independent instances on a shared client.
await runExample(Effect.gen(function* () {
	const client = yield* EvmClient.make({ network: { chainId: BigInt(process.env["CHAIN_ID"] ?? "8453") } })
	const params = { address: process.env["POOL"] ?? "0x6c561B446416E1A00E8E93E221854d6eA4171372" }
	const first = yield* PoolIndex.make({ client, params, namespace: "first", plan: { live: { start: "head" } } })
	const second = yield* PoolIndex.make({ client, params, namespace: "second", plan: { live: { start: "head" } } })
	yield* first.watch("current").pipe(Stream.runForEach((value) => Effect.log("Current pool", value)), Effect.forkScoped)
	yield* first.run().pipe(Effect.forkScoped)
	yield* second.run().pipe(Effect.forkScoped)
	yield* Effect.sleep(10_000)
	yield* first.close()
	yield* Effect.log("First instance closed; second instance and client remain open", second.isClosed, client.isClosed)
	yield* second.close()
	yield* client.close()
	// Scope exit also closes each resource. Repeated close calls are safe.
}))

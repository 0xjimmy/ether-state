import { Cause, Effect, Exit } from "effect"
import type { Scope } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import type { HttpClient } from "effect/unstable/http"
import { Socket } from "effect/unstable/socket"

/** Ctrl+C interrupts the program and waits for scoped database and RPC cleanup. */
export async function runExample(program: Effect.Effect<unknown, unknown, Scope.Scope | HttpClient.HttpClient | Socket.WebSocketConstructor>): Promise<void> {
	const controller = new AbortController()
	const stop = () => { controller.abort() }
	process.once("SIGINT", stop)
	process.once("SIGTERM", stop)
	try {
		const exit = await Effect.runPromiseExit(Effect.scoped(program).pipe(
			Effect.provide(FetchHttpClient.layer), Effect.provide(Socket.layerWebSocketConstructorGlobal)), { signal: controller.signal })
		if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) throw new Error(Cause.pretty(exit.cause))
	} finally {
		process.removeListener("SIGINT", stop)
		process.removeListener("SIGTERM", stop)
	}
}

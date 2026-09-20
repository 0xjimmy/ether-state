import { Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect"

/** An owned scope that also follows the scope in which it was created. */
export interface Lifetime {
	readonly scope: Scope.Closeable
	readonly close: Effect.Effect<void>
	readonly isClosed: boolean
	readonly run: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
	readonly watch: <A, E, R>(stream: Stream.Stream<A, E, R>) => Stream.Stream<A, E, R>
}
export const makeLifetime: Effect.Effect<Lifetime, never, Scope.Scope> = Effect.gen(function* () {
	const scope = yield* Scope.make()
	const stopped = yield* Deferred.make<undefined>()
	const finished = yield* Deferred.make<undefined>()
	let closed = false
	const close = Effect.uninterruptible(Effect.suspend(() => {
		if (closed) return Deferred.await(finished)
		closed = true
		return Deferred.succeed(stopped, undefined).pipe(
			Effect.andThen(Scope.close(scope, Exit.void)),
			Effect.ensuring(Deferred.succeed(finished, undefined)), Effect.asVoid)
	}))
	yield* Effect.addFinalizer(() => close)
	return {
		scope, close,
		get isClosed() { return closed },
		run: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => Effect.suspend(() => closed ? Effect.interrupt :
			Effect.uninterruptibleMask((restore) => restore(effect).pipe(Effect.forkIn(scope), Effect.flatMap((fiber) =>
				restore(Fiber.join(fiber)).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))))))),
		watch: <A, E, R>(stream: Stream.Stream<A, E, R>): Stream.Stream<A, E, R> =>
			Stream.suspend(() => closed ? Stream.empty : stream.pipe(Stream.interruptWhen(Deferred.await(stopped)))),
	}
})

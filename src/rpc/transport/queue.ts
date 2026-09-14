import { Deferred, Effect, Exit, Semaphore } from "effect"
import type { Scope } from "effect"

export interface QueueFull { readonly _tag: "QueueFull"; readonly capacity: number }

interface Pending<A, B, E> {
	readonly input: A
	readonly result: Deferred.Deferred<B, E>
}

export class BatchQueue<A, B, E> {
	private readonly pending = new Set<Pending<A, B, E>>()
	private running = false

	constructor(private readonly options: {
		readonly scope: Scope.Scope
		readonly window: number
		readonly size: number
		readonly capacity: number
		readonly run: (inputs: readonly A[]) => Effect.Effect<readonly Exit.Exit<B, E>[], E>
	}) {}

	get size(): number { return this.pending.size }

	request(input: A): Effect.Effect<B, E | QueueFull> {
		return Effect.uninterruptibleMask((restore) => Effect.gen({ self: this }, function* () {
			if (this.pending.size >= this.options.capacity) return yield* Effect.fail<QueueFull>({ _tag: "QueueFull", capacity: this.options.capacity })
			const entry = { input, result: yield* Deferred.make<B, E>() }
			this.pending.add(entry)
			if (!this.running) {
				this.running = true
				yield* Effect.forkIn(this.drain(), this.options.scope)
			}
			return yield* restore(Deferred.await(entry.result)).pipe(Effect.ensuring(Effect.sync(() => { this.pending.delete(entry) })))
		}))
	}

	private drain(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			while (this.pending.size > 0) {
				yield* Effect.sleep(this.options.window)
				const entries = [...this.pending].slice(0, this.options.size)
				if (entries.length === 0) continue
				yield* this.options.run(entries.map((entry) => entry.input)).pipe(Effect.onExit((exit) =>
					Effect.forEach(entries, (entry, index) => {
						this.pending.delete(entry)
						const result = Exit.isFailure(exit) ? Exit.failCause(exit.cause) : exit.value[index] ?? Exit.die("Missing batch result")
						return Deferred.done(entry.result, result)
					}, { discard: true })), Effect.ignore)
			}
		}).pipe(Effect.onExit((exit) => Effect.gen({ self: this }, function* () {
			this.running = false
			if (Exit.isFailure(exit)) {
				const entries = [...this.pending]
				this.pending.clear()
				yield* Effect.forEach(entries, (entry) => Deferred.failCause(entry.result, exit.cause), { discard: true })
			}
		})))
	}
}

interface EndpointBudget {
	readonly permits: Semaphore.Semaphore
	readonly livePermits: Semaphore.Semaphore
	readonly sent: number[]
	limit: number
	active: number
}

export class RequestScheduler {
	private readonly endpoints = new Map<string, EndpointBudget>()
	private queued = 0
	constructor(private readonly options: { readonly rps: number; readonly concurrency: number; readonly capacity: number }) {}

	load(endpoint: string): number { return this.endpoints.get(endpoint)?.active ?? 0 }
	limit(endpoint: string): number { return this.endpoints.get(endpoint)?.limit ?? this.options.rps }
	throttle(endpoint: string): void {
		const budget = this.endpoints.get(endpoint)
		if (budget !== undefined) budget.limit = Math.max(1, Math.min(budget.limit - 1, budget.sent.length - 1))
	}

	run<A, E, R>(endpoint: string, live: boolean, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | QueueFull, R> {
		return Effect.suspend((): Effect.Effect<A, E | QueueFull, R> => {
			if (this.queued >= this.options.capacity) return Effect.fail<QueueFull>({ _tag: "QueueFull", capacity: this.options.capacity })
			let budget = this.endpoints.get(endpoint)
			if (budget === undefined) {
				budget = { permits: Semaphore.makeUnsafe(this.options.concurrency), livePermits: Semaphore.makeUnsafe(2),
					sent: [], limit: this.options.rps, active: 0 }
				this.endpoints.set(endpoint, budget)
			}
			const selected = budget
			this.queued++
			selected.active++
			const acquire: Effect.Effect<void> = Effect.suspend(() => {
				const now = Date.now()
				while (selected.sent[0] !== undefined && selected.sent[0] <= now - 1_000) selected.sent.shift()
				if (selected.sent.length >= selected.limit) return Effect.sleep(Math.max(1, (selected.sent[0] ?? now) + 1_000 - now)).pipe(Effect.andThen(acquire))
				selected.sent.push(now)
				return Effect.void
			})
			return (live ? selected.livePermits : selected.permits).withPermit(acquire.pipe(Effect.andThen(effect))).pipe(
				Effect.ensuring(Effect.sync(() => { this.queued--; selected.active-- })))
		})
	}
}

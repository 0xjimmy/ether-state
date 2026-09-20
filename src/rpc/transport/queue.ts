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
	private wake: Deferred.Deferred<undefined> | undefined

	constructor(private readonly options: {
		readonly scope: Scope.Scope
		readonly window: number
		readonly size: number
		readonly maxWeight?: number
		readonly weight?: (input: A) => number
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
			if (this.wake !== undefined && this.isFull()) yield* Deferred.succeed(this.wake, undefined)
			return yield* restore(Deferred.await(entry.result)).pipe(Effect.ensuring(Effect.sync(() => { this.pending.delete(entry) })))
		}))
	}

	private weight(entries: readonly Pending<A, B, E>[]): number {
		const weight = this.options.weight
		return weight === undefined ? entries.length
			: entries.reduce((total, entry) => total + Math.max(0, weight(entry.input)), 0)
	}

	private isFull(): boolean {
		const entries = [...this.pending]
		return entries.length >= this.options.size ||
			(this.options.maxWeight !== undefined && this.weight(entries) >= this.options.maxWeight)
	}

	private take(): readonly Pending<A, B, E>[] {
		const selected: Pending<A, B, E>[] = []
		for (const entry of this.pending) {
			if (selected.length >= this.options.size) break
			const next = [...selected, entry]
			if (selected.length > 0 && this.options.maxWeight !== undefined && this.weight(next) > this.options.maxWeight) break
			selected.push(entry)
		}
		return selected
	}

	private drain(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			while (this.pending.size > 0) {
				const wake = yield* Deferred.make<undefined>()
				this.wake = wake
				if (!this.isFull()) yield* Effect.race(Effect.sleep(this.options.window), Deferred.await(wake))
				if (this.wake === wake) this.wake = undefined
				const entries = this.take()
				if (entries.length === 0) continue
				yield* this.options.run(entries.map((entry) => entry.input)).pipe(Effect.onExit((exit) =>
					Effect.forEach(entries, (entry, index) => {
						this.pending.delete(entry)
						const result = Exit.isFailure(exit) ? Exit.failCause(exit.cause) : exit.value[index] ?? Exit.die("Missing batch result")
						return Deferred.done(entry.result, result)
					}, { discard: true })), Effect.ignore)
			}
		}).pipe(Effect.onExit((exit) => Effect.gen({ self: this }, function* () {
			this.wake = undefined
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
		readonly sent: number[]
	limit: number
	recoverAt: number
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
		if (budget !== undefined) { budget.limit = Math.max(1, Math.floor(budget.limit * 0.75)); budget.recoverAt = Date.now() + 5_000 }
	}

	recover(endpoint: string): void {
		const budget = this.endpoints.get(endpoint)
		if (budget !== undefined && Date.now() >= budget.recoverAt) {
			budget.limit = Math.min(this.options.rps, budget.limit + 1)
			budget.recoverAt = Date.now() + 5_000
		}
	}

	run<A, E, R>(endpoint: string, _live: boolean, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | QueueFull, R> {
		return Effect.suspend((): Effect.Effect<A, E | QueueFull, R> => {
			if (this.queued >= this.options.capacity) return Effect.fail<QueueFull>({ _tag: "QueueFull", capacity: this.options.capacity })
			let budget = this.endpoints.get(endpoint)
			if (budget === undefined) {
				budget = { permits: Semaphore.makeUnsafe(this.options.concurrency),
					sent: [], limit: this.options.rps, recoverAt: 0, active: 0 }
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
			return selected.permits.withPermit(acquire.pipe(Effect.andThen(effect))).pipe(
				Effect.ensuring(Effect.sync(() => { this.queued--; selected.active-- })))
		})
	}
}

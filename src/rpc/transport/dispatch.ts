import { Effect } from "effect"

/** Runs at each raw transaction network attempt. Throwing also declines. */
export type BeforeDispatch = () => "approve" | "decline"
export interface DispatchDeclined { readonly _tag: "DispatchDeclined" }
export const dispatchApproved = (guard?: BeforeDispatch): boolean => {
	try { return guard === undefined || guard() === "approve" } catch { return false }
}
export const checkDispatch = (guard?: BeforeDispatch): Effect.Effect<void, DispatchDeclined> =>
	Effect.suspend(() => dispatchApproved(guard) ? Effect.void : Effect.fail({ _tag: "DispatchDeclined" }))

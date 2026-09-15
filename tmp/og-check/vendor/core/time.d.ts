/**
 * Timestamp handling for the learning model.
 *
 * Every timestamp Familiar stores is written by Python's
 * `datetime.now(timezone.utc).isoformat()`, so it carries *microseconds*:
 *
 *     2026-08-30T02:47:04.671168+00:00
 *
 * `new Date(...)` resolves only milliseconds and would silently discard the
 * rest. That matters more than it sounds: a card at the model's minimum
 * stability of 0.02 days decays at roughly 50x per day, so throwing away
 * 671 microseconds moves predicted recall by ~4e-7 — far above the tolerance
 * the parity suite holds Python and TypeScript to. So timestamps are parsed
 * here rather than delegated to `Date`.
 *
 * An instant is kept as an integer millisecond count plus a sub-millisecond
 * remainder. Epoch milliseconds are around 1.8e12, where a double's precision
 * is only about 0.24 microseconds, so adding fractional milliseconds directly
 * into that magnitude would round away the precision we just went to the
 * trouble of parsing. Subtracting the integer and fractional parts separately
 * keeps the difference exact.
 */
export interface Instant {
    /** Whole milliseconds since the Unix epoch. */
    readonly ms: number;
    /** Remaining fraction of a millisecond, in [0, 1). */
    readonly subMs: number;
}
/** Days assumed since review when a card has never been reviewed. */
export declare const NEVER_REVIEWED_DAYS = 365;
/**
 * Parse an ISO 8601 timestamp, preserving sub-millisecond precision.
 *
 * A timestamp with no zone is read as UTC. Python's `fromisoformat` would
 * instead produce a naive datetime and raise when compared to an aware one,
 * so this is deliberately more permissive than the Python it replaces; the
 * app itself only ever writes explicit offsets.
 */
export declare function parseIsoInstant(value: string): Instant;
/** Coerce the several shapes a caller may hold "now" in into an Instant. */
export declare function toInstant(value: Instant | string | number | Date): Instant;
/**
 * Whole days between two instants, never negative.
 *
 * Mirrors `days_since` in the Python model, including its treatment of a
 * missing timestamp as a year and its clamping of future timestamps to zero.
 */
export declare function daysSince(timestamp: string | null | undefined, now: Instant | string | number | Date): number;
//# sourceMappingURL=time.d.ts.map
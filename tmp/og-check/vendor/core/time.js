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
const ISO_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|z|[+-]\d{2}:?\d{2})?$/;
/** Days assumed since review when a card has never been reviewed. */
export const NEVER_REVIEWED_DAYS = 365;
const MS_PER_DAY = 86_400_000;
/**
 * Parse an ISO 8601 timestamp, preserving sub-millisecond precision.
 *
 * A timestamp with no zone is read as UTC. Python's `fromisoformat` would
 * instead produce a naive datetime and raise when compared to an aware one,
 * so this is deliberately more permissive than the Python it replaces; the
 * app itself only ever writes explicit offsets.
 */
export function parseIsoInstant(value) {
    const match = ISO_PATTERN.exec(value.trim());
    if (!match)
        throw new Error(`Not an ISO 8601 timestamp: ${JSON.stringify(value)}`);
    const [, year, month, day, hour, minute, second, fraction, zone] = match;
    let ms = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), second === undefined ? 0 : Number(second));
    let subMs = 0;
    if (fraction !== undefined && fraction !== '') {
        // Read the fraction as nanoseconds so 6- and 9-digit timestamps agree,
        // then split it across the two fields.
        const nanoseconds = Number((fraction + '000000000').slice(0, 9));
        const fractionalMs = nanoseconds / 1e6;
        const whole = Math.floor(fractionalMs);
        ms += whole;
        subMs = fractionalMs - whole;
    }
    if (zone !== undefined && zone !== 'Z' && zone !== 'z') {
        const sign = zone.startsWith('-') ? -1 : 1;
        const digits = zone.slice(1).replace(':', '');
        const offsetMinutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
        ms -= sign * offsetMinutes * 60_000;
    }
    return { ms, subMs };
}
/** Coerce the several shapes a caller may hold "now" in into an Instant. */
export function toInstant(value) {
    if (typeof value === 'string')
        return parseIsoInstant(value);
    if (typeof value === 'number') {
        const whole = Math.floor(value);
        return { ms: whole, subMs: value - whole };
    }
    if (value instanceof Date) {
        const ms = value.getTime();
        return { ms, subMs: 0 };
    }
    return value;
}
/**
 * Whole days between two instants, never negative.
 *
 * Mirrors `days_since` in the Python model, including its treatment of a
 * missing timestamp as a year and its clamping of future timestamps to zero.
 */
export function daysSince(timestamp, now) {
    if (!timestamp)
        return NEVER_REVIEWED_DAYS;
    const reviewed = parseIsoInstant(timestamp);
    const current = toInstant(now);
    const elapsedMs = current.ms - reviewed.ms + (current.subMs - reviewed.subMs);
    return Math.max(0, elapsedMs / MS_PER_DAY);
}
//# sourceMappingURL=time.js.map
/**
 * Two narrowing helpers, so the tests can index into arrays and maps under
 * `noUncheckedIndexedAccess` without an `!` in every assertion.
 *
 * Both throw rather than returning a default. A test that quietly ran its assertions
 * against `undefined` would report green while checking nothing, which is the exact failure
 * this suite is built to avoid.
 */

/** The single element of an array that must contain exactly one. */
export function only<T>(values: readonly T[]): T {
  if (values.length !== 1) throw new Error(`expected exactly one value, got ${values.length}`);
  return values[0] as T;
}

/** A lookup result that must have been found. `what` names it in the failure. */
export function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}

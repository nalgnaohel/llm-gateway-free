/**
 * Test-only relaxation: `Response.json()` is typed `Promise<unknown>` by the
 * runtime typings, which forces a cast at every assertion site. Tests assert on
 * the shape directly, so widen it here rather than littering the specs.
 */
declare global {
  interface Response {
    json(): Promise<any>;
  }
}
export {};

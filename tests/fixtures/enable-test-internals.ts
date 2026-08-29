/**
 * Must be imported before any provider module under test.
 * Enables exposeForTests() side-channel (THEORUM_TEST_INTERNALS=1).
 */
Deno.env.set('THEORUM_TEST_INTERNALS', '1');

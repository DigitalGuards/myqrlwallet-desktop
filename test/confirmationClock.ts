import assert from 'node:assert/strict';
import timers from 'node:timers/promises';
import type { SuiteContext, TestContext } from 'node:test';

/** Install a fresh gate with a clock driven entirely by the test's fake timers. */
export async function mockConfirmationClock(t: TestContext | SuiteContext): Promise<void> {
  assert.ok('mock' in t);
  const { ConfirmationGate, confirmationGate } = await import('../src/main/confirmationGate');
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 0 });
  const gate = new ConfirmationGate({
    now: () => Date.now(),
    wait: (milliseconds, signal) => timers.setTimeout(milliseconds, undefined, { signal }),
  });
  t.mock.method(confirmationGate, 'show', gate.show.bind(gate));
  t.mock.method(confirmationGate, 'abort', gate.abort.bind(gate));
}

/** Drain native-dialog and abort promise continuations without advancing time. */
export async function flushConfirmations(): Promise<void> {
  await timers.setImmediate();
}

export async function advanceConfirmations(t: TestContext, milliseconds: number): Promise<void> {
  t.mock.timers.tick(milliseconds);
  await flushConfirmations();
}

/** Drive the bounded page sequence for tests concerned with review content. */
export async function finishConfirmation<T>(t: TestContext, promise: Promise<T>): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let step = 0; step < 20; step++) {
    await flushConfirmations();
    if (settled) return promise;
    t.mock.timers.tick(1000);
  }
  assert.fail('confirmation did not settle within twenty arming intervals');
}

/**
 * Pure state-machine runner
 * Zones: shared utils
 * Owns committing a pure transition's next state, running the effects it returns and waking state waiters
 * Knows nothing about the machines it drives: their state, events, effects, timers and transports stay with each domain
 */

/** One transition result: the next state plus effects as data. A machine may add fields, such as a call result. */
export interface BaleMachineStep<State, Effect> {
  state: State;
  effects: readonly Effect[];
}

export interface BaleMachineRunner<State, Event, Step> {
  readonly state: State;
  /** Commits the next state, runs its effects (which may dispatch again), wakes waiters and returns the step. */
  dispatch(event: Event): Step;
  /** Resolves once `ready` holds for the committed state, checking now and after every later dispatch. */
  waitFor(ready: (state: State) => boolean): Promise<void>;
}

export function createBaleMachineRunner<
  State,
  Event,
  Effect,
  Step extends BaleMachineStep<State, Effect> = BaleMachineStep<
    State,
    Effect
  >,
>(options: {
  initial: State;
  transition: (state: State, event: Event) => Step;
  run: (effect: Effect) => void;
}): BaleMachineRunner<State, Event, Step> {
  let state = options.initial;
  const waiters = new Set<() => void>();
  return {
    get state(): State {
      return state;
    },
    dispatch(event: Event): Step {
      const next = options.transition(state, event);
      state = next.state;
      for (const effect of next.effects) options.run(effect);
      for (const waiter of [...waiters]) waiter();
      return next;
    },
    waitFor(ready: (state: State) => boolean): Promise<void> {
      return new Promise((resolve) => {
        if (ready(state)) return resolve();
        const waiter = (): void => {
          if (!ready(state)) return;
          waiters.delete(waiter);
          resolve();
        };
        waiters.add(waiter);
      });
    },
  };
}

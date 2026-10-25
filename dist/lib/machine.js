/**
 * Pure state-machine runner
 * Zones: shared utils
 * Owns committing a pure transition's next state, running the effects it returns and waking state waiters
 * Knows nothing about the machines it drives: their state, events, effects, timers and transports stay with each domain
 */
export function createBaleMachineRunner(options) {
    let state = options.initial;
    const waiters = new Set();
    return {
        get state() {
            return state;
        },
        dispatch(event) {
            const next = options.transition(state, event);
            state = next.state;
            for (const effect of next.effects)
                options.run(effect);
            for (const waiter of [...waiters])
                waiter();
            return next;
        },
        waitFor(ready) {
            return new Promise((resolve) => {
                if (ready(state))
                    return resolve();
                const waiter = () => {
                    if (!ready(state))
                        return;
                    waiters.delete(waiter);
                    resolve();
                };
                waiters.add(waiter);
            });
        },
    };
}

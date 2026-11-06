'use strict';

function makeError(code, message) {
  const err = new Error(`[pdf-render-pool] ${message}`);
  err.code = code;
  return err;
}

function abortError() {
  const err = makeError('ABORT_ERR', 'Render aborted.');
  err.name = 'AbortError';
  return err;
}

/**
 * Minimal async concurrency limiter. Tasks queue FIFO and run as slots free up.
 * @param {number} max - maximum number of tasks allowed to run concurrently.
 * @param {number} [maxQueue=Infinity] - maximum number of tasks allowed to wait; beyond this, run() rejects with code 'EQUEUEFULL'.
 */
function createSemaphore(max, maxQueue = Infinity) {
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const entry = queue.shift();
    entry.dequeued();
    Promise.resolve()
      .then(entry.task)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };

  /**
   * @param {() => Promise<any>} task
   * @param {{ signal?: AbortSignal, queueTimeout?: number }} [options] - both only apply while the task is waiting for a slot.
   */
  function run(task, { signal, queueTimeout = Infinity } = {}) {
    if (signal && signal.aborted) return Promise.reject(abortError());
    // Only tasks that would actually have to wait count against the queue limit.
    if (active >= max && queue.length >= maxQueue) {
      return Promise.reject(makeError('EQUEUEFULL', `Render queue is full (${maxQueue} waiting).`));
    }
    return new Promise((resolve, reject) => {
      let timer = null;
      const entry = { task, resolve, reject, dequeued() {} };
      const drop = (err) => {
        const i = queue.indexOf(entry);
        if (i === -1) return;
        queue.splice(i, 1);
        entry.dequeued();
        reject(err);
      };
      const onAbort = () => drop(abortError());
      entry.dequeued = () => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      };
      entry.drop = drop;
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      if (queueTimeout !== Infinity) {
        timer = setTimeout(
          () => drop(makeError('EQUEUETIMEOUT', `Waited more than ${queueTimeout}ms for a render slot.`)),
          queueTimeout,
        );
      }
      queue.push(entry);
      next();
    });
  }

  run.stats = () => ({ active, queued: queue.length });
  /** Reject everything still waiting for a slot. */
  run.rejectQueued = (err) => {
    for (const entry of [...queue]) entry.drop(err);
  };
  return run;
}

module.exports = { createSemaphore, makeError, abortError };

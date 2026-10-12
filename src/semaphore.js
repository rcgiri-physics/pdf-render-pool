'use strict';

/**
 * Minimal async concurrency limiter. Tasks queue FIFO and run as slots free up.
 * @param {number} max - maximum number of tasks allowed to run concurrently.
 * @param {number} [maxQueue=Infinity] - maximum number of tasks allowed to wait; beyond this, run() rejects with code 'EQUEUEFULL'.
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
function createSemaphore(max, maxQueue = Infinity) {
  const limit = Math.max(1, parseInt(max, 10) || 1);
  const queueLimit = maxQueue === Infinity ? Infinity : Math.max(0, parseInt(maxQueue, 10) || 0);
  let active = 0;
  const queue = [];

  const next = () => {
    if (active >= limit || queue.length === 0) return;
    active += 1;
    const { task, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        next();
      });
  };

  function run(task) {
    // Only tasks that would actually have to wait count against the queue limit.
    if (active >= limit && queue.length >= queueLimit) {
      const err = new Error(`[pdf-render-pool] Render queue is full (${queueLimit} waiting).`);
      err.code = 'EQUEUEFULL';
      return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  }

  run.stats = () => ({ active, queued: queue.length });
  return run;
}

module.exports = { createSemaphore };

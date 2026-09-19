'use strict';

/**
 * Minimal async concurrency limiter. Tasks queue FIFO and run as slots free up.
 * @param {number} max - maximum number of tasks allowed to run concurrently.
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
function createSemaphore(max) {
  const limit = Math.max(1, parseInt(max, 10) || 1);
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

  return function run(task) {
    return new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      next();
    });
  };
}

module.exports = { createSemaphore };

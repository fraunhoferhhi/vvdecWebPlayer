'use strict';

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

class AsyncWaitCondition {
  #resolve;
  #reject;
  #promise;

  constructor() {
    this.#promise = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  release() {
    console.assert(this.#reject !== undefined, "AsyncWaitCondition already rejected.");
    if (this.#resolve && this.#reject) {
      this.#resolve();
      this.#resolve = undefined;
    }
  }

  abort() {
    console.assert(this.#resolve !== undefined, "AsyncWaitCondition already resolved.");
    if (this.#reject && this.#reject) {
      this.#reject();
      this.#reject = undefined;
    }
  }

  get promise() {
    return this.#promise;
  }

  reset() {
    this.#promise = new Promise((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }
}

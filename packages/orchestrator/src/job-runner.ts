export class JobRunner {
  private queue = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

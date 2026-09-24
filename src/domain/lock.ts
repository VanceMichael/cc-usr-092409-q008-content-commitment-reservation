/**
 * 键级异步互斥。
 *
 * 容量占用的“检查余额 -> 预留”必须在同一预算池维度内串行化，
 * 两个项目并发争用同一池余额时，拿到锁的先成功，后者看到更新后的余额。
 *
 * 注意：前序任务的业务异常（如余额不足）绝不能毒化等待队列——
 * 排队链只用于“串行”，异常在各自的调用中独立传播。
 */
export class KeyedLock {
  private tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // 链尾只等待“前序已结束”，不继承其结果或错误
    const chained = previous.then(() => gate, () => gate);
    this.tails.set(key, chained);
    try {
      await previous.then(
        () => undefined,
        () => undefined,
      );
      return await fn();
    } finally {
      release();
      // 仅当队列尾部仍是本次任务时清理，避免删掉后继者
      if (this.tails.get(key) === chained) this.tails.delete(key);
    }
  }
}

import type { DomainEvent } from "../domain/events.js";
import type { EventStore } from "./event-store.js";

interface PendingTask {
  taskId: string;
  taskType: string;
  payload: unknown;
  runAt: number;
  finished: boolean;
}

/**
 * 任务以 TaskEnqueued/TaskFinished 事件持久化。
 * 定时器只存在于内存：重启后重放事件，到期任务立即执行，未到期任务重新挂表。
 */
export class TaskScheduler {
  private readonly pending = new Map<string, PendingTask>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(
    private readonly store: EventStore,
    private readonly clock: () => number,
    private readonly handler: (taskType: string, payload: unknown) => Promise<void> | void,
    private readonly automatic = true,
  ) {
    store.onEvent((event) => this.onEvent(event));
    store.replay((event) => this.ingest(event, /*live*/ false));
  }

  private ingest(event: DomainEvent, live: boolean): void {
    if (event.type === "TaskEnqueued") {
      const d = event.data as {
        taskId: string;
        taskType: string;
        payload: unknown;
        runAt: number;
      };
      this.pending.set(d.taskId, {
        taskId: d.taskId,
        taskType: d.taskType,
        payload: d.payload,
        runAt: d.runAt,
        finished: false,
      });
      if (live && this.started) this.schedule(d.taskId);
    } else if (event.type === "TaskFinished") {
      const d = event.data as { taskId: string };
      const task = this.pending.get(d.taskId);
      if (task) task.finished = true;
      const timer = this.timers.get(d.taskId);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(d.taskId);
      }
    }
  }

  private onEvent(event: DomainEvent): void {
    this.ingest(event, true);
  }

  enqueue(taskType: string, payload: { taskId: string } & Record<string, unknown>, runAt: number): void {
    if (this.pending.has(payload.taskId)) return;
    // 任务载荷是判别联合（见 TaskPayloadMap），调用方保证 kind 完整。
    this.store.append("TaskEnqueued", {
      taskId: payload.taskId,
      taskType,
      payload: payload as never,
      runAt,
    });
  }

  /** 服务完成状态装载后调用：恢复全部未完成任务。 */
  start(): void {
    this.started = true;
    const now = this.clock();
    for (const [id, task] of this.pending) {
      if (task.finished) continue;
      this.schedule(id, now);
    }
  }

  private schedule(id: string, now: number = this.clock()): void {
    if (!this.automatic) return;
    const task = this.pending.get(id);
    if (!task || task.finished || this.timers.has(id)) return;
    const delay = Math.max(0, task.runAt - now);
    const timer = setTimeout(() => {
      void this.run(id);
    }, delay);
    // 允许测试进程在仍有定时器时退出。
    if (typeof timer.unref === "function") timer.unref();
    this.timers.set(id, timer);
  }

  private async run(id: string): Promise<void> {
    const task = this.pending.get(id);
    if (!task || task.finished) return;
    if (task.runAt > this.clock()) {
      // 被定时器提前唤醒（如超长延时被运行时钳制）：重新挂表等待。
      this.timers.delete(id);
      this.schedule(id);
      return;
    }
    try {
      await this.handler(task.taskType, task.payload);
      if (!this.pending.get(id)?.finished) {
        this.store.append("TaskFinished", { taskId: id, result: "done" });
      }
    } catch (err) {
      // 处理失败时保留任务并在短退后重试，直到成功（重启后也会继续）。
      if (!this.automatic) throw err;
      const retryAt = this.clock() + 1_000;
      task.runAt = retryAt;
      this.timers.delete(id);
      const timer = setTimeout(() => void this.run(id), Math.max(0, retryAt - this.clock()));
      if (typeof timer.unref === "function") timer.unref();
      this.timers.set(id, timer);
    }
  }

  /** 测试/关停辅助：立即执行所有到期任务。 */
  async runDue(now: number = this.clock()): Promise<void> {
    const due = [...this.pending.values()]
      .filter((t) => !t.finished && t.runAt <= now)
      .map((t) => t.taskId);
    for (const id of due) {
      const timer = this.timers.get(id);
      if (timer) {
        clearTimeout(timer);
        this.timers.delete(id);
      }
      if (!this.pending.get(id)?.finished) await this.run(id);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  get pendingCount(): number {
    return [...this.pending.values()].filter((t) => !t.finished).length;
  }
}

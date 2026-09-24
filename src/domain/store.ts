/**
 * 仅追加（append-only）事件日志。
 *
 * 持久化形态：DATA_DIR/events.jsonl，每行一个 StoredEvent。
 * 服务启动时重放全部事件折叠内存状态；任何写操作先同步落盘再折叠，
 * 进程崩溃后最多丢失未落盘的调用，已落盘历史不可修改。
 */
import fs from "node:fs";
import path from "node:path";
import type { DomainEvent, StoredEvent } from "./model.js";

export class EventStore {
  readonly filePath: string;
  private events: StoredEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: StoredEvent) => void>();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, "events.jsonl");
    this.replay();
  }

  private replay() {
    if (!fs.existsSync(this.filePath)) return;
    const lines = fs.readFileSync(this.filePath, "utf8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const stored = JSON.parse(trimmed) as StoredEvent;
      this.events.push(stored);
      this.seq = Math.max(this.seq, stored.seq);
    }
  }

  /** 订阅新事件；启动重放完成后注册的监听只会收到新事件 */
  subscribe(fn: (e: StoredEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  all(): readonly StoredEvent[] {
    return this.events;
  }

  /** 同步追加：先落盘（含 flush），再通知折叠器 */
  append(event: DomainEvent, at = new Date().toISOString()): StoredEvent {
    const stored: StoredEvent = { seq: ++this.seq, at, event };
    fs.appendFileSync(this.filePath, JSON.stringify(stored) + "\n", { flag: "a" });
    this.events.push(stored);
    for (const fn of this.listeners) fn(stored);
    return stored;
  }
}

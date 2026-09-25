import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  writeSync,
  fsyncSync,
  mkdirSync,
  renameSync,
} from "node:fs";
import { dirname } from "node:path";
import type { DomainEvent, EventData } from "../domain/events.js";

const BI_TAG = "$bigint";

type Listener = (event: DomainEvent) => void;

/** 仅用于 JSON 序列化 bigint。 */
function replacer(_key: string, value: unknown): unknown {
  if (typeof value === "bigint") return { [BI_TAG]: value.toString() };
  return value;
}

function reviver(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 1 &&
    BI_TAG in (value as Record<string, unknown>)
  ) {
    return BigInt((value as Record<string, string>)[BI_TAG]);
  }
  return value;
}

/**
 * 仅追加事件日志。每条事件以单行 JSON 落盘并 fsync；
 * 写入采用“临时文件 + 改名”的方式不适用追加日志，这里保持同一 fd 顺序追加。
 * ":memory:" 用于测试。
 */
export class EventStore {
  private readonly events: DomainEvent[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly fd: number | null;
  private closed = false;
  private seq = 0;

  constructor(private readonly path: string | ":memory:", clock: () => number = Date.now) {
    this.clock = clock;
    if (path === ":memory:") {
      this.fd = null;
      return;
    }
    mkdirSync(dirname(path), { recursive: true });
    this.fd = openSync(path, "a");
    if (existsSync(path)) {
      const raw = readFileSync(path, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        const event = JSON.parse(line, reviver) as DomainEvent;
        this.events.push(event);
        this.seq = Math.max(this.seq, event.seq);
      }
    }
  }

  private clock: () => number;

  /** 重放已持久化事件（不触发实时监听者）。 */
  replay(apply: (event: DomainEvent) => void): void {
    for (const event of this.events) apply(event);
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  all(): readonly DomainEvent[] {
    return this.events;
  }

  get lastSeq(): number {
    return this.seq;
  }

  /** 串行追加；调用方（服务层）保证命令之间互斥。 */
  append<T extends DomainEvent["type"]>(
    type: T,
    data: EventData[T],
  ): { seq: number; at: number; type: T; data: EventData[T] } {
    const event = { seq: ++this.seq, at: this.clock(), type, data };
    if (this.fd !== null) {
      const line = JSON.stringify(event, replacer) + "\n";
      writeSync(this.fd, line);
      fsyncSync(this.fd);
    }
    this.events.push(event as unknown as DomainEvent);
    for (const listener of this.listeners) listener(event as unknown as DomainEvent);
    return event;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) closeSync(this.fd);
  }

  /** 仅供排障/导出使用：把内存事件另存为新的 JSONL 文件。 */
  snapshotTo(targetPath: string): void {
    const tmp = `${targetPath}.tmp`;
    mkdirSync(dirname(targetPath), { recursive: true });
    const fd = openSync(tmp, "w");
    try {
      for (const event of this.events) {
        writeSync(fd, JSON.stringify(event, replacer) + "\n");
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, targetPath);
  }
}

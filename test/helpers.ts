import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { EventStore } from "../src/store/event-store.js";
import { ProcurementService } from "../src/service/procurement-service.js";

export interface Harness {
  svc: ProcurementService;
  store: EventStore;
  now: number;
  tick: (ms: number) => void;
  runDue: () => Promise<void>;
  close: () => void;
  dataDir?: string;
}

/** 手动调度 + 假时钟：任务只在 runDue() 时执行，时间完全可控。 */
export function harness(start = 1_000_000): Harness {
  let now = start;
  const clock = () => now;
  const store = new EventStore(":memory:", clock);
  const svc = new ProcurementService(store, clock, false);
  svc.start();
  return {
    svc,
    store,
    now,
    tick(ms: number) {
      now += ms;
    },
    async runDue() {
      await svc.runDueTasks();
    },
    close() {
      svc.stop();
      store.close();
    },
  };
}

/** 文件日志夹具，用于重启恢复测试。 */
export function fileHarness(start = 1_000_000, automatic = false) {
  const dataDir = mkdtempSync(join(tmpdir(), "procurement-"));
  let now = start;
  const clock = () => now;
  const path = join(dataDir, "procurement-events.jsonl");
  const store = new EventStore(path, clock);
  const svc = new ProcurementService(store, clock, automatic);
  svc.start();
  return {
    svc,
    store,
    dataDir,
    path,
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
    tick(ms: number) {
      now += ms;
    },
    /** 用同一事件日志启动新实例（模拟重启）。 */
    restart(automaticNext = true) {
      svc.stop();
      store.close();
      const store2 = new EventStore(path, clock);
      const svc2 = new ProcurementService(store2, clock, automaticNext);
      svc2.start();
      return { svc: svc2, store: store2 };
    },
    close() {
      svc.stop();
      store.close();
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 标准场景：CNY 池 10_000；预测 2026Q3 收入 40_000/50_000/60_000。 */
export async function seedStandardScenario(h: Harness, poolTotal = 10_000n, period = "2026Q3") {
  const dims = { currency: "CNY", region: "APAC", contentType: "SERIES", period };
  const { poolKey } = await h.svc.createPool({ ...dims, totalMinor: poolTotal });
  await h.svc.defineFxVersion({ version: "fx-1", rates: {}, base: "CNY" });
  await h.svc.activateFx("fx-1");
  await h.svc.publishForecast({
    forecastId: "F-1",
    currency: "CNY",
    assumptions: { ad_growth: 0.08, churn: 0.03 },
    periods: [
      { period: "2026Q3", downsideMinor: 40_000n, baseMinor: 50_000n, upsideMinor: 60_000n },
      { period: "2026Q4", downsideMinor: 44_000n, baseMinor: 56_000n, upsideMinor: 70_000n },
    ],
  });
  return { poolKey, dims };
}

export function standardTerms(overrides: Partial<{
  guaranteeMinor: bigint;
  milestoneMinor: bigint;
  bips: number;
  periods: string[];
  currency: string;
}> = {}) {
  return {
    currency: overrides.currency ?? "CNY",
    guaranteeMinor: overrides.guaranteeMinor ?? 1_000n,
    milestones: [
      { id: "m1", amountMinor: overrides.milestoneMinor ?? 500n, duePeriod: "2026Q3" },
    ],
    contingent: { bips: overrides.bips ?? 1_000, periods: overrides.periods ?? ["2026Q3"] },
  };
}

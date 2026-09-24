/**
 * 运行时装配：事件日志 -> 投影 -> 领域服务 / 分析视图，
 * 以及服务重启后的恢复（续跑重评任务、补偿到期占用）与周期维护。
 */
import { Analytics } from "./domain/analytics.js";
import { Projection } from "./domain/projections.js";
import { CommitmentService } from "./domain/service.js";
import { EventStore } from "./domain/store.js";

export interface RuntimeHandle {
  store: EventStore;
  projection: Projection;
  service: CommitmentService;
  analytics: Analytics;
  /** 停止周期维护 */
  stop: () => void;
}

export interface RuntimeOptions {
  dataDir: string;
  /** 周期维护间隔（毫秒），默认 60s；0 表示关闭定时器（测试用） */
  maintenanceIntervalMs?: number;
  logger?: Pick<Console, "info" | "error">;
}

export async function createRuntime(options: RuntimeOptions): Promise<RuntimeHandle> {
  const log = options.logger ?? console;
  const store = new EventStore(options.dataDir);
  const projection = new Projection();

  // 启动重放：折叠全部历史事件，恢复内存状态
  for (const stored of store.all()) projection.apply(stored);
  // 之后每落盘一条新事件，同步折叠进投影（append 先落盘再通知）
  store.subscribe((stored) => projection.apply(stored));

  const service = new CommitmentService(store, projection);
  const analytics = new Analytics(projection, store);

  // 重启恢复：继续处理未落盘完成的重评任务，并释放已到期占用
  async function maintenanceTick(source: string) {
    try {
      const expired = await service.scanExpiries();
      const { processed, failed } = await service.processReevaluationJobs();
      if (expired || processed || failed) {
        log.info(
          `[maintenance:${source}] 到期释放=${expired} 重评完成=${processed} 待重试=${failed}`,
        );
      }
    } catch (err) {
      log.error(`[maintenance:${source}] 失败: ${(err as Error).message}`);
    }
  }

  await maintenanceTick("startup");

  let timer: NodeJS.Timeout | undefined;
  if (options.maintenanceIntervalMs !== 0) {
    timer = setInterval(
      () => void maintenanceTick("timer"),
      options.maintenanceIntervalMs ?? 60_000,
    );
    timer.unref?.();
  }

  return {
    store,
    projection,
    service,
    analytics,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}

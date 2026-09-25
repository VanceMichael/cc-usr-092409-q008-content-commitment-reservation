# 内容采购保底承诺与预测占用服务

在保底（minimum guarantee）、里程碑付款与阶梯/或有分成签署前，统一管理预算池容量占用，
避免同一预算空间被多个项目重复承诺，并在预测/汇率/进度变化时给出可追溯的重评与缺口处置。

## 核心规则

- **预算池版本化**：按 `币种 + 地区 + 内容类型 + 期间`（季度 `YYYYQn` 或月份 `YYYY-MM`）唯一定义；
  总额调整产生新版本，签署合同快照保留签署时的池版本。
- **谈判方案引用已发布预测**：申请必须指定预测 ID/版本，记录关键假设哈希；
  方案同时钉住提交时的汇率版本。
- **压力区间**：按 `downside / base / upside` 三档计算
  `保底 + 当期里程碑 + 或有分成(bips × 当期预测收入)`；金额一律为币种最小单位 **bigint 整数**，
  汇率以 1e6 缩放存储整数。一个占用绑定一个池期间，跨期合同须按池分别申请。
- **有期限容量占用**：申请即按 base 档占用并设定 TTL；
  - 相同请求（幂等键 + 请求指纹一致）重试**沿用原占用**；
  - 金额或条款变化形成**新版本**，旧版本经补偿事件释放；
  - 取消、驳回、到期、合同终止都通过补偿事件释放容量；
  - 两个项目并发争用同一余额时，经命令串行化保证**只有一个成功**，后到者收到 `409 BUDGET_EXHAUSTED`。
- **职责分离**：审批人不能批准自己提交的方案。
- **只重评未签占用**：预测被替代、汇率版本变化、项目延期时，自动重算尚未签约占用的压力区间
  （延期跨池时以补偿事件把占用平移到目标期间池）；余额不足不回滚，而是挂 `shortfallMinor` 与风险旗标，
  批准时必须提供足额池级豁免。
- **已签合同不可倒改**：签署时固化池版本、预测全文（含假设）、汇率表与压力区间快照；
  外部变化只生成**缺口处置提案**（OPEN，可豁免/重谈/追加预算/驳回），历史永不改写。
- **持久化与恢复**：所有状态变更以事件追加到 JSONL（fsync）；到期释放与重评也是持久化任务，
  服务重启后重放事件并继续执行未完成任务。
- **管理看板**：`/scenarios` 按池给出三档场景下的已签、占用、可用、豁免余量与风险缺口；
  `/pools/:key` 与 `/proposals/:id/history` 支持从任一数字钻取到合同版本、预测依据与人工豁免。

## 运行

```bash
npm ci
npm test
npm run build
docker build -t content-forecast-engine .
docker run --rm -p 8080:8080 -v $(pwd)/data:/data content-forecast-engine
curl http://localhost:8080/health
```

事件日志默认写入 `$DATA_DIR/procurement-events.jsonl`（运行约定 `/data`）。

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/admin/pools` | 创建版本化预算池 |
| POST | `/admin/pools/:poolKey/versions` | 发布池总额新版本 |
| POST | `/forecasts` | 发布预测（再次发布即替代上一版本，触发重评） |
| POST | `/fx/versions` | 定义汇率版本（必须覆盖全部在用币种） |
| POST | `/fx/versions/:version/activate` | 启用汇率版本（触发重评） |
| POST | `/waivers` | 授予人工豁免（池级/占用级/缺口级） |
| POST | `/proposals` | 提交谈判方案（幂等键 + TTL + 条款 + 预测引用） |
| POST | `/proposals/:id/approve` | 审批（禁止自审；有缺口须带豁免） |
| POST | `/proposals/:id/sign` | 签署（固化快照） |
| POST | `/proposals/:id/reject` `/cancel` `/terminate` | 驳回 / 取消 / 合同终止（补偿释放） |
| POST | `/projects/:id/delay` | 项目延期 n 个期间（触发重评） |
| POST | `/gaps/:id/resolve` | 处置缺口（WAIVED/RENEGOTIATED/TOPPED_UP/DISMISSED） |
| GET | `/gaps` | 缺口提案列表 |
| GET | `/pools` `/pools/:poolKey?band=` | 池余额明细与钻取 |
| GET | `/scenarios` | 三场景对比看板 |
| GET | `/proposals/:id/history` | 版本链、签署快照、缺口、豁免全链路 |

金额字段在 JSON 中为整数字符串（最小货币单位），避免 JS Number 精度损失。

### 提交示例

```json
POST /proposals
{
  "idempotencyKey": "deal-2026Q3-001",
  "projectId": "PRJ-A",
  "pool": {"currency": "CNY", "region": "APAC", "contentType": "SERIES", "period": "2026Q3"},
  "terms": {
    "currency": "CNY",
    "guaranteeMinor": "100000",
    "milestones": [{"id": "m1", "amountMinor": "50000", "duePeriod": "2026Q3"}],
    "contingent": {"bips": 1000, "periods": ["2026Q3"]}
  },
  "forecastId": "F-1",
  "forecastVersion": 1,
  "submittedBy": "alice",
  "ttlMs": 604800000,
  "waiverIds": []
}
```

## 代码结构

- `src/domain/` — 金额/汇率（bigint）、期间、压力区间、领域类型与事件契约
- `src/store/` — 仅追加事件存储、持久化任务调度器
- `src/service/` — 采购承诺服务（命令串行化、申请/审批/签署、重评、缺口、看板）
- `src/http/` — Fastify 路由与 bigint JSON 编解码
- `test/` — 领域、服务、重评/恢复、边界与 HTTP 端到端测试

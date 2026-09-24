# 内容采购承诺与容量占用服务

在保底（MG）与阶梯分成合同签署前，本服务统一管理谈判方案对预算池的**容量占用**，
解决三个核心问题：

1. **重复承诺**：同一预算空间不能被多个项目重复预占——申请时在预算池维度串行化，
   并发争用只有一个成功；
2. **场景下调后谁要重谈**：预测被替代、汇率版本变化或项目延期时，**只重评未签约占用**，
   已签合同保留签署时快照并自动生成缺口处置提案，历史不可倒改；
3. **数字可追溯**：管理层看到的已签 / 占用 / 可用 / 风险缺口，每个数字都能下钻到
   合同版本、预测依据（含关键假设快照）和人工豁免。

## 核心概念

| 概念 | 说明 |
| --- | --- |
| 预算池 Pool | 按**币种 × 地区 × 内容类型 × 期间**四个维度识别；同一维度线可发布新版本（如下调限额），全部历史版本保留 |
| 预测 Forecast | 必须先发布才能被谈判方案引用；新版本自动替代旧版，旧版标记 `superseded`；方案冻结引用版本的关键假设副本 |
| 汇率 Fx | 版本化汇率表；跨币种方案随新版本重评，纯同币种方案不受影响 |
| 谈判方案 Proposal | 一次申请产生一个**占用版本**；相同申请（幂等键）重试沿用原占用；金额/条款变化形成新版本 |
| 压力区间 Stress | 按下行 / 基准 / 上行三档收入假设，分别计算 保底 + 里程碑 + 或有阶梯分成（换算到池币种）；容量以**基准总额**预留 |
| 占用 Occupancy | 有有效期（默认 14 天），到期未签约自动释放；状态机：待审批 → 已批准 → 已签约，或被拒/取消/到期/终止 |
| 合同 Contract | 签约即**快照**：预算版本、预测版本、汇率版本、条款与压力区间全部冻结，之后任何变化不改合同 |
| 补偿事件 | 取消、到期、合同终止统一以补偿事件释放容量，容量流水严格对称 |
| 重评任务 | 预测替代 / 汇率变化 / 延期 / 预算下调为受影响的未签约占用入队；任务持久化，服务重启后续跑 |
| 缺口提案 Gap | 已签合同在依据变化后产生（重谈 / 预算调拨 / 缩减范围 / 豁免承接），合同金额不动 |
| 豁免 Waiver | 重评后容量不足、或管理层确认承接缺口时使用；豁免可撤销，撤销后方案恢复为不可批准/签约 |

## 关键不变量

- **金额**：一律使用各币种最小单位（minor unit）的**整数**运算，比例结果四舍五入，无浮点金额；
- **并发**：余额检查与预留入账在同一预算池的键级锁内原子完成；
- **幂等**：申请必须携带幂等键（`body.idempotencyKey` 或 `Idempotency-Key` 头），重试不重复占容量；
- **职责分离**：审批人不能批准自己提交的方案（403 `SELF_APPROVAL_FORBIDDEN`）；
- **不可倒改**：事件只追加（`DATA_DIR/events.jsonl`），合同/占用历史版本永久保留；
- **重评边界**：只影响未签约占用；已签合同只产生缺口提案；
- **重评后果**：依据变化后原批准失效，已批准方案回到待审批；容量不足时标记违约，必须取得
  覆盖缺口的有效豁免才能再次批准/签约。

## HTTP API（JSON，金额为 minor unit 整数）

### 基础数据
- `POST /v1/pools` 发布/新版本化预算池；`POST /v1/pools/:id/close`
- `POST /v1/forecasts` 发布预测（带 `forecastId` 再发即新版本并替代旧版）
- `POST /v1/forecasts/:id/supersede` 跨预测线替代
- `POST /v1/fx` 发布新汇率版本；`GET /v1/fx`

### 谈判方案全生命周期
- `PUT  /v1/proposals` 提交申请（需幂等键）；返回三档压力区间与预留额；重复申请返回 `200 {reused:true}`
- `GET  /v1/proposals/:id` 全部占用版本
- `POST /v1/proposals/:id/decisions` `{approver, decision: approved|rejected, comment?}`
- `POST /v1/proposals/:id/sign` 签约（冻结快照）
- `POST /v1/proposals/:id/cancel` 取消（补偿释放）
- `POST /v1/projects/:projectId/delay` 项目延期（触发重评 + 合同缺口提案）
- `POST /v1/contracts/:id/terminate` 合同终止（补偿释放）

### 豁免与缺口
- `POST /v1/waivers`、`POST /v1/waivers/:id/revoke`、`GET /v1/waivers`
- `GET  /v1/gaps?status=open`、`POST /v1/gaps/:id/resolve`

### 管理视图
- `GET /v1/ledger/pools/:poolId` 单池台账：每档场景的 signed / occupied / committed / available / riskGap，
  以及可下钻的合同与占用条目（版本、预测依据快照、豁免、违约、缺口）
- `GET /v1/scenarios/compare?region=&contentType=&period=` 按币种聚合的多场景对比
- `GET /v1/lineage/proposals/:id` 完整血缘：占用版本、审批、豁免、缺口、补偿、重评任务、事件轨迹
- `GET  /v1/events` 审计用事件日志；`GET /v1/jobs?status=pending`
- `POST /v1/maintenance/run` 手动触发到期释放与重评续跑

## 本地运行

```bash
npm ci
npm test          # 21 个领域/HTTP 测试
npm run build
DATA_DIR=/data PORT=8080 node dist/src/server.js
# 或
docker build -t content-forecast-engine .
docker run --rm -p 8080:8080 -v $(pwd)/data:/data content-forecast-engine
```

服务启动时重放 `$DATA_DIR/events.jsonl` 恢复全部状态，立即执行一次到期释放与重评续跑，
之后每 60 秒维护一次（可通过 `maintenanceIntervalMs` 调整，`0` 关闭定时器）。

## 快速示例

```bash
# 1) 发布预算池（CNY，分）与预测
curl -s -X POST localhost:8080/v1/pools -H 'content-type: application/json' -d '{
  "poolId":"p1",
  "key":{"currency":"CNY","region":"CN","contentType":"drama","period":"2026H1"},
  "minorUnit":2,"limit":1000000000,"by":"finance"}'

curl -s -X POST localhost:8080/v1/forecasts -H 'content-type: application/json' -d '{
  "forecastId":"f1","currency":"CNY","minorUnit":2,"periods":["2026H1"],
  "assumptions":{"revenueByScenario":{"downside":300000000,"base":800000000,"upside":1500000000},"factors":{}},
  "by":"fpa"}'

# 2) 提交方案：保底 100M + 里程碑 50M + 0~500M 分 10%、以上 20% 分成
curl -s -X PUT localhost:8080/v1/proposals -H 'content-type: application/json' -H 'idempotency-key: demo-1' -d '{
  "proposalId":"pr1","projectId":"P1","poolId":"p1","forecastId":"f1","forecastVersion":1,
  "terms":{
    "guarantee":{"amount":100000000,"currency":"CNY","minorUnit":2},
    "milestones":[{"code":"m1","trigger":"母带交付","dueDate":"2026-06-30",
                   "amount":{"amount":50000000,"currency":"CNY","minorUnit":2}}],
    "royaltyTiers":[{"threshold":0,"rate":0.1},{"threshold":500000000,"rate":0.2}],
    "contingentCap":null},
  "submittedBy":"buyer.zhang"}'
# -> stress: downside 180M / base 260M(预留) / upside 400M
```

## 目录结构

```
src/domain/
  model.ts       领域类型与事件定义（不可变历史）
  math.ts        整数金额、汇率换算、阶梯分成与三档压力区间
  lock.ts        键级异步互斥（并发争用串行化）
  store.ts       仅追加事件日志（落盘 + 启动重放）
  projections.ts 读模型折叠（版本线、容量流水、合同、缺口、任务）
  service.ts     命令逻辑（不变量、审批、重评、补偿、豁免）
  analytics.ts   台账 / 多场景对比 / 血缘视图
src/runtime.ts   装配 + 启动恢复 + 周期维护
src/routes.ts    HTTP API
contracts/       输入边界 schema；fixtures/ 指标口径示例
```

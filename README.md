# 内容行业预测口径服务

本项目用于保存预测场景并按统一指标口径推演内容行业收入。`contracts/` 定义输入边界，`fixtures/` 保存指标与公式示例，`src/` 是 HTTP 应用入口。

```bash
npm ci
npm test
npm run build
docker build -t content-forecast-engine .
docker run --rm -p 8080:8080 content-forecast-engine
curl http://localhost:8080/health
```

运行数据目录约定为 `/data`，金额计算以指标目录声明的单位和精度为准。

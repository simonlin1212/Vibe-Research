# 数据源 adapter + registry(Phase 1)

`registry.json` 是运行时端点注册表，记录各端点的市场、来源、合规标记、参数、阶段与启用状态。
完整目录见 [CATALOG.md](CATALOG.md)，由 `gen_catalog.py` 生成并通过测试核对端点清单。

合规标记和已登记不等于本次可用；当前取数成功、缺口和限制以运行信封为准，也不构成对所有来源商用或再分发权限的保证。

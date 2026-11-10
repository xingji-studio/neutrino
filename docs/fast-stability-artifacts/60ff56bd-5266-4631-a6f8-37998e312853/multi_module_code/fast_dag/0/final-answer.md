已完成并通过全局复核（只使用 node，全部工作都在临时 fixture `/tmp/neutrino-fast-live-PgKqxR/multi_module_code/fast_dag/0` 内，未访问凭据或外部服务）。

**交付物**
- `tax.mjs`：`export function tax(amount) { return amount * 0.2; }`
- `shipping.mjs`：`export function shipping(weight) { return 3 + 2 * weight; }`
- `answer.json`：`{"tax100":20,"shipping2":7}`（由导入两个函数计算后写入，两个值均为 JSON 数字）

**验证**
- `node test.mjs` → 输出 `PASS`，退出码 0（复核时重跑，exit=0）。
- `answer.json` 仅含键 `tax100`、`shipping2`，`typeof` 均为 `number`，值 20 / 7，与 `tax(100)`、`shipping(2)` 的实时输出一致。
- 独立性：对两个模块 grep `import|require` 结果为空（NO_IMPORTS），二者互不依赖。
- 无跨任务冲突：验证任务 `main.verify` 独立读取全部文件并重跑测试，结论与 `main` 一致，未发现缺陷。

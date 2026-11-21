# 迷雾群岛 · 环境自检 · 2026-11-21

| 检查项 | 结果 | 值或错误摘要 |
|---|---|---|
| Blender CLI 本体 | ✅ | Blender 4.3.2（`D:\Program Files\Blender Foundation\Blender 4.3\blender.exe`），后台 `-b --factory-startup --python-expr` 打印 `BLENDER_OK 4.3.2` 并正常退出 |
| 截图能力 | ✅ | Chrome 120+ headless（`C:\Program Files\Google\Chrome\Application\chrome.exe`）用于 UI 设计稿与实机截图；Blender 侧用 `-b` 离线渲染输出 PNG |
| 运行时依赖 | ✅ | Node v22.23.2（≥20）、npm 10.9.8、Python 3.12.9（`python` 直接可用，非商店占位符） |
| 图形与硬件 | ✅ | NVIDIA GeForce RTX 4060 Laptop GPU；另有 Oray/AskLink/GameViewer 虚拟显示适配器（远程串流用，不影响 WebGL） |
| 浏览器 WebGL | ✅ | Chrome 可用，WebGL2 由 Three.js 在零件 03 实机阶段实测记录 |

## 结论

**可以开工。** Blender 4.3.2 ≥ 推荐 4.2，Node 22 ≥ 最低 20，Chrome 与独立 GPU 齐备。Blender 未加入 PATH，后续所有脚本统一使用上面的绝对路径调用，不修改系统环境变量。Blender MCP 未在本机配置，按零件 02 回退口径改用 CLI 后台模式，验收证据以离线渲染 PNG 与浏览器实机截图提供，不伪称 MCP 连通。

## 建议的引擎设置

- **渲染引擎**：Eevee（低模风格化、导出前快速预览）；Cycles 仅用于最终美术静帧，不作为日常迭代默认。
- **分辨率**：离线预览 1280×720；最终美术图 1920×1080。
- **采样数**：Eevee TAA 64；Cycles 64 + 降噪（RTX 4060 Laptop 保守值，避免长时阻塞迭代）。
- **导出**：glTF 2.0 `.glb`，三角化在导出时固定，法线策略与零件 18 约定一致。

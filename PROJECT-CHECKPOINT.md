# PROJECT CHECKPOINT

## PROJECT GOAL
在独立目录中用 Blender 重建当前场景里穿模、丑陋或诡异的资产，保留用户认可的雪松、仙人掌、椰子树和大树，并将新资产替换进实际游戏。用户否决 V2 美术后，以认可资产为视觉母体完成 V3 美术修订。

## DEFINITION OF DONE
- `world_v2/` 包含可编辑 Blender 源工程、独立构建脚本、GLB、manifest 和审查渲染。
- 雪松、仙人掌、椰子树、古树资产保持原样；其余资产完成重建。
- 新模型为闭合、有厚度、轮廓合理的低模资产，具备近/远 LOD 与正确碰撞数据。
- 游戏默认加载新模型库，类型检查、生产构建、模型结构校验通过。
- 浏览器实机检查无模型缺失、明显穿模、悬浮或碰撞轮廓错位。
- 美术上不再用“能加载/面数达标”代替视觉验收；森林树、草甸树与认可古树具有一致的厚冠层和枝干风格。

## REQUIREMENTS / LEDGER
| ID | Requirement | Priority | Status | Evidence |
|---|---|---|---|---|
| R1 | 保留雪松、仙人掌、椰子树和大树 | P0 | DONE | `assets:validate` 确认 8 个保留 ID 的近景/LOD 三角面与原版一致 |
| R2 | 新建独立目录 | P0 | DONE | `world_v2/blender/`、`world_v2/renders/`、`world_v2/review.html` |
| R3 | 重建其余低质量资产 | P0 | DONE | `build_report.json` 列出 47 个重建 ID；V3 重做树、灌木、花、拱门、沼泽柳、母菌和喷口 |
| R4 | 新模型具备 LOD、顶点色、碰撞与接地 | P0 | DONE | `assets:validate`：55 模型、126 网格、顶点色/LOD/碰撞/接地通过 |
| R5 | 替换游戏默认模型库 | P0 | DONE | `app/public/models/prefabs.glb/json` 为 V3；浏览器加载 55/55，missing 为空 |
| R6 | 类型检查、构建、浏览器实机验收 | P0 | DONE | `npm run typecheck`、`npm run build`、`npm run world:analyze` 均通过；Chromium 实机 0 error |
| R7 | 控制性能预算 | P0 | DONE | 最终实机约 225,817 三角面、169 draw call；小型资产 10/22 BU、灌木 12/24 BU 分级 LOD |
| R8 | 按认可资产做美术对标 | P0 | DONE | 森林树/草甸树直接以古树几何为母体；`compare_tree_style.png`、`compare_browser_v3.png` |

## CONSTRAINTS
- 不覆盖或删除现有 `world/` 资产工程。
- 不读取仓库外历史恢复包。
- 不引入外部游戏素材。
- 保留当前未提交改动。

## LATEST VERIFIED STATE
- Blender 4.3.2 构建成功：55 个模型，近景源资产合计 59,750 三角面，LOD 合计 12,038。
- 8 个用户认可资产保持原样，47 个资产重建；V3 对高优先级资产做了第二轮美术修订。
- 运行时：3,388 个实例、75 个实体、80 个碰撞体，非法碰撞 0。
- 浏览器实机：约 225,817 三角面、169 draw call、0 console error、55/55 模型加载。
- 地形回归：0 NaN，出生点高度 2.33 BU。
- 硬件 GPU 的 45fps 门槛未在 headless SwiftShader 环境测量；不把软件帧率当作硬件验收结果。

## ART EVIDENCE
- `world_v2/renders/compare_tree_style.png`：认可古树、森林树、草甸树并排。
- `world_v2/renders/compare_browser_v3.png`：V2 与 V3 实机并排。
- `world_v2/renders/review_all_v3.png`：全部模型总览。
- `world_v2/renders/v3_*.png`：关键模型近照。
- `world_v2/renders/browser_v3.png`：最终实机图。

## NEXT ACTION
None. V3 美术修订、接入、验证和性能收敛均已完成。

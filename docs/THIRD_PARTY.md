# 第三方组件、服务与许可边界

源码依赖版本以 package-lock.json 为准；Python 依赖见 python/requirements.txt 和 python/requirements-matting.txt。第三方组件不因本仓库公开而改变自身许可。此清单是维护入口，不是完整法律审计。

| 组件/服务 | 用途 | 来源 |
|---|---|---|
| React / Vite / TypeScript | 画布与构建 | 各依赖包附带许可 |
| Express / MCP SDK | 本机服务与 Codex 桥接 | 各依赖包附带许可 |
| ag-psd / sharp / @napi-rs/canvas | PSD 与图像处理 | 各依赖包附带许可 |
| Playwright / Edge | 浏览器自动化与测试 | 各发行方条款 |
| U2NetP 与 ONNX Runtime | 可选本地粗抠 | [rembg 权重来源](https://github.com/danielgatis/rembg)；权重与实现应分别核对 |
| BiRefNet_HR-matting | 本地高分辨率软蒙版 | [官方模型](https://huggingface.co/ZhengPeng7/BiRefNet_HR-matting)；固定版本和摘要见 python/matting_models.json |
| Lucida v7 | 本地软蒙版，与 BiRefNet 独立选择 | [作者模型](https://huggingface.co/egeorcun/lucida)；固定 v7 快照，摘要见 python/matting_models.json |
| Vectorizer.com | 免费网页转换，模型未公开确认 | [官网](https://vectorizer.com/) |
| Recraft | 官方矢量化 API | [官网](https://www.recraft.ai/) |
| Vectorizer.AI | 原厂 API | [官网](https://vectorizer.ai/)、[API 文档](https://vectorizer.ai/api/documentation) |
| 302.AI | Vectorizer.AI 国内转接 | [接口来源](https://302.ai/product/detail/vectorize)、[原厂](https://vectorizer.ai/) |
| Photoshop MCP | 可选社区连接 | [社区项目](https://github.com/alisaitteke/photoshop-mcp) |
| Photoshop / Illustrator | 最终原生软件交接 | Adobe 官方产品及对应接口文档 |
| canvas-hand | 标注交互参考 | [参考项目](https://github.com/Tasihi89/canvas-hand) |

网页自动化不等于拥有官方集成授权；免费服务也可能限制自动使用、上传量或第三方集成。部署或分发前自行核对最新服务条款，不承诺永久免费、无人验证或稳定下载。

API 价格与可用性由服务商决定。项目设置的价格是参考信息，提交前以自己的账户和服务商结算为准；本仓库不赠送 API 余额或 Adobe 许可。

历史 SuperSVG / AdaVec 研究脚本和旧 ISNet 分支已移除，当前安装不下载其权重。未随仓库分发任何模型权重、第三方论文全文或参考项目素材。仅删除项目直接声明中不再使用的依赖，不主动卸载用户共享 Python 环境中的间接依赖。

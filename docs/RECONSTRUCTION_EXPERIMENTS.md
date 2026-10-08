# 隔离重建实验

### C81：窄条参考呈现保留透明承载

R52四栏已按短正文拆组，但两路col1-cn的235×64冻结框在首次referenceScale:4 prepare前被carrier.expanded限制拒绝；没有文字模型调用。允许已有normal透明承载一起等比呈现，禁止放大裸裁片后错配承载位置。原局部、透明承载和呈现件分别绑定摘要；全部参考原样/精确RGBA重编码禁止登记为生成素材，后续原局部或承载变更必须阻断使用。透明留白计入150万像素，超预算不降倍率、不裁边；冻结source/frame/anchors/计划/旧请求不变。周边、细节、screen、background及原生/保护路由仍拒绝。

两路HTTP离线回归只验证上述接口和防护；必须在R52相同冻结源继续首次真实短正文生成、PS真实置入和文字对照。两路人物已有位置/细节差异，真实完整输出和独立整体验收未通过，不因本项工程检查结束循环。

### C80：背景保留指令按归属替换

R51两条独立真实背景都移除了人物和器材，却保留全部四栏文字、图表和页脚；它们已经公开标为needs-revision。旧背景开头仍沿用前景“保留参考字形和细节”的指令，与后面的排除项形成冲突。新v4背景的structured和concise-edit均改成只保留本层拥有的环境材质、结构和原位；归其他组的图文即使印在纸/墙/器物上也移除并补底材，不替换成新字。明确属于本层的文字、刻纹、细线和固定灯继续保留，不按关键词删除所有文字。

没有图像后处理、OCR抠字、源像素遮罩或自动改排除清单；用户意见、引用身份、预算和已有请求保持。R51人物双手和头部改绘仍失败；C79实际两路膜的四项alpha检查、默认PS光效Screen子层/Pass Through父组及真实渲染通过只是局部证据。下一实验轮必须用针对纸面图文归属失败的新复杂海报；密集正文按既有C52分组复核，不能沿用整列一组的方法。C80工程检查不是背景实际成功或两路整体通过。

### C79：薄膜的显式椭圆透空窗

R51真实新源在计划冻结前可见两个圆窗透出海面。无孔膜会把孔额外着色，不能把后景复制进独立“圆形标记”掩盖。普通nativeGeometry v2的shape及PS nativeFilm可声明cutouts数组（1–8个），每项严格{name,center:[x,y],radiusX,radiusY,angle}，唯一名称、有限画布像素、半径>1、角度-180..180。每个椭圆须完整在冻结frame及直线凸四边形膜内；椭圆承载框保守不相交以免evenodd孔相消。PS带孔时外沿仅四个直线结点，入/出控制点与锚点相同，不开放任意曲面挖孔。

孔以人工观察参数制作，不读取源mask/裁片/像素描摹；冻结圆窗clear、膜transmissive和光学件关系。普通使用真正透明RGBA、证明算法native-tinted-film-cutouts-v3；PS使用可编辑subtract椭圆Bezier路径及原生透明渐变，回读数量/运算/控制点和实际alpha。普通实际渲染与真实PS各自独立回执；工程缓存或元数据不冒称PS已运行，也不自动视觉accepted。旧无孔膜和v1实体保持原算法及结果兼容，旧任务不能追加孔。

### C78：普通薄膜本体改用显式参数渲染

R50实际普通膜窗36像素0通过，alpha242..244、黑白底响应11..13，片外清空不能证明膜透光。新普通v4可在首次prepare前冻结nativeGeometry配方v2：单个无孔凸四边形、实色RGB、线性alpha渐变（angle -180..180；2–8个严格递增色标，position端点0/1、alpha1..254）。必须是独立v2 thin-film，带clear/transmissive冻结检查；不能混用nativeText、contourSearch、背景保护、screen或辅助载体。四角/颜色/alpha是明确观察与制作参数，不从扁平源推断物理透射率，不取源像素或源mask。复杂反光/印字/水滴另作独立件。

沿用prepare与render-native-geometry，输出来源native-geometry-renderer、证明算法native-tinted-film-quadrilateral-v2。完整载体含留白<=150万像素，等比渲染，旧v1实体算法保持原名与原结果兼容。外部register、晚改配方、异任务/参考变更和事后align仍拒绝；真实alpha诊断及合成审核仍必需。普通是透明位图；PS拒绝此v2实体入口并继续使用nativeFilm原生透明渐变。C78工程夹具通过不代表真实复杂海报/两路整体验收，下一新轮需换针对本失败的复杂源，同轮不得追改R50。

C73还替换了竞争候选的判定单位：按实际轮廓矩形四角在参考像素中的最大位移识别不同位置，超过2个分析像素才算独立竞争者，代替旧的3%尺度/8像素中心规则。小定位符的3%尺度可能只改变一个整数像素，旧规则会误称另一位置；新规则同时把同尺度超过2像素的位置差计作竞争，避免旧8像素中心忽略附近副本。竞争分数差0.35、比例1.4、覆盖、方向、留出检验门槛均保留。报告包含实际最佳/竞争边界及分析比例，不等同定位或整体视觉接受。

C73候选为新v4独立v2实体件提供事前`contourSearch:{version:1,box:[x,y,width,height],observation}`，坐标为冻结最终画布像素，须完整属于该件画幅。它限制自动配准测量的目标范围，减少同一透明组件下方条码/文字对上方定位符的竞争；完整模型参考、生成文件和透明度均保留，不生成源蒙版、不裁切结果、不按候选事后选区。普通normal前景或PS generate实体件可用，不支持薄膜、原生文字、背景、光效或辅助matte/参考扩展。计划在首次prepare前冻结，请求及测量报告绑定相同范围。SIFT留出检查、轮廓覆盖/方向/竞争差距原门槛不变；范围内有两个相似目标仍须拒绝。旧R46没有事前范围，不能事后追加后宣称接受，仅做只读回归；新实验必须换针对该失败的新复杂源。工程检查与旧图测量均不是视觉验收。

C61缩放修复：真实R42的C60输出失败后，工程夹具确认完整双板Lanczos3跨中线插值会使正确黑白配对产生866个不相容像素（最大误差4）。新请求须在首次prepare前显式packedBackdrop.version:2及normalization:'whole-carrier-nearest-v1'，只对完整载体执行两板共享的唯一像素中心索引表最近邻预算缩小、偶数工作宽和固定中线；同一索引表复制原件两板对应像素，避免通用resize采样相位差；不对单板找边界、重新配准、调alpha或放宽原方程。可能损失少量细线采样，仍须真实原尺寸/几何/小字审核。旧version1、R42原件/工作件/失败回执保持原Lanczos3，不重解释为新方法。新kernel无法修复真实模型原件中的前景漂移或残留环境；不能把工程零误差当R42或整图通过。

C60单次双板实验：新普通v4单normal透明层可在首次prepare前冻结packedBackdrop:{version:1,arrangement:'black-left-white-right',panelSize:{width,height}}，同时冻结clear/transmissive/occupied（或opaque）区域。不能与旧matte、字体、背景保护、光效或周边/缩放/细节参考混用；panel比例须匹配完整设计frame。prepare返回一张左黑右白、无间隔/标签的完整carrier请求与transparent_background:false。两板总工作像素含留白≤150万，不是每板分别150万。真实生成原件先全图验证单张8位PNG/alpha255/偶数宽及完整比例；原件不变，只在超预算时统一缩小完整carrier，中线固定，禁止内容检测、单板配准、拉伸或换图。register返回packedId和intermediateOnly，不能直接合成/完成。derive-packed-alpha传packedId及expectedCarrierHash（working.hash），从该真实生成carrier固定中线拆板并运行同一黑白解混方程；不从源图或预抠取得最终像素。板件来源是generated-panel，只有carrier是一次image_gen，最终kind/receipt为derived-packed-alpha，不能冒称两次模型输出或单层生图原件。解混前验证双板clear区域；不相容保存真实绑定failure.json与板件，0新增RGBA，拒绝重复同请求/同方法prepare及同carrier派生。成功派生也须以实际原件/完整carrier/板件/固定方程重新认证，source/layout/request/尺寸/位置/文件变化使已有review/composite/apply失效；不能通过派生后定位或调alpha逃避失败。一份文件并不证明两个前景一致，工程通过不是实际视觉接受。此版本只适用普通路线；PS仍须自己的真实素材与原生渲染，不借用普通结果冒充PS独立生成。

C59失败循环约束：双背景固定解混出现真实不相容诊断时，后台在本job保存failure.json和绑定task/job/base/aux/双工作摘要的matteFailures，生成层数组不新增RGBA。写入前再次CAS和双来源文件校验，旧任务及其他组不迁移。相同双输入不重复派生；同一基底和冻结binding已有失败时不再prepare白底请求，须先改变前景表示或联合生成方法。R41真实两次RGB并未保持同一前景，普通拒绝891345/1497760像素；PS独立透明材质实际原生置入与渲染仍薄透失败。不得把黑底空隙通过、原件登记、空PSD组或测试通过当完整验收，不重复两张RGB提示。


C58双背景实验：新普通v4首次prepare前冻结allowAuxMatte、clear/transmissive及固有黑印字的occupied/opaque区域，matteBackdrop:{version:2,color:"#000000",space:"srgb-byte-v1"}。第一份真实输出是彩色黑底RGB中间件；第二份aux prepare必须明确matteEncoding:"white-composite-rgb8-v1"，生成相同几何/颜色的彩色白底RGB，不再预测灰度覆盖图。两份完整原件均先验证8位sRGB PNG及alpha255，再保留原件并按150万预算归一；白底保留彩色通道，不转灰。派生要求完整工作件同尺寸，不自动配准/裁切/补边；固定aByte=round(255-mean(whiteRGB-blackRGB))、F=blackRGB/(aByte/255)，逐像素再合成两份实际RGB最大误差≤2，任何不相容像素拒绝，不调alpha或放宽标准。零alpha RGB清零，黑色固有印字也能恢复高覆盖。黑/白底分别按冻结clear区域检查原位底色±2及原合格比例；occupied/opaque仍需独立检查，方程本身不能发现两次都省略的内容。算法black-white-composite-unmix-v1、双来源角色与文件摘要必须保持；原始RGB和aux均不可直接作为最终层。旧version1中灰与缺字段算法不迁移；PS仍不支持本实验。它是工程候选，真实生成会否保持前景未知，数值相容不代表物理光学或海报一致性。


### C56 已知底色前景解混实验

C57根据R40真实双输入失败增加必要条件：在创建辅助matte请求前，按真实完整RGB原位检查冻结clear区域是否保持#808080±2，合格比例沿用该clear已冻结要求；失败不再追加matte调用。完整解混诊断分别报告零alpha区域底色偏差和非空材质覆盖不足/几何错误，以及最大再合成误差、少量carrier坐标样例与最低数学可行alpha。最低可行alpha仅解释失败，绝不据此调高实际matte或放宽固定误差。旧无matteBackdrop的算法与请求不改变。

旧派生只改alpha、保留RGB，无法去除已经混进颜色的后景。新普通v4材质层可在首次prepare前显式声明`allowAuxMatte:true`与`matteBackdrop:{version:1,color:"#808080",space:"srgb-byte-v1"}`，同时冻结clear和transmissive检查。后台先准备真实生图输出：物体保持源中几何，移除组外后景，改在自身全不透明的中灰底上呈现材质；然后另一次真实生图输出冻结完整carrier的灰阶matte。中灰RGB登记为`matte-rgb-base`，只能供matte/派生使用，不能直接合成、审核通过或交付为正式层。完整原件alpha逐像素必须255，先检查再缩小，证明由真实原件重算。

派生使用固定8位编码域source-over方程`F=(C-(1-a)*128)/a`同时恢复前景RGB和alpha；a为固定灰阶matte/255，零alpha的RGB清零。不采样源图，不使用预抠，不改变matte曲线、阈值或整层opacity。检查实际PNG与计算RGBA完全一致，并验证在冻结中灰底上的再合成最大通道误差≤2；不相容时保留原件并拒绝，不靠裁边、错位、颜色截断掩盖。此误差只证明两份输入与固定方程相容，不证明源图保真或物理透射；彩色折射玻璃无法一般化成单一alpha。

只适用于新普通v4单normal透明材质；与nativeText、背景保护、screen、context/detail/scale参考实验互斥；PS仍明确unsupported，不把普通派生冒称真实PS结果。旧请求保持原算法、RGB逐字节不变；不能事后追写底色。下一实际模型轮用针对字形、薄透后景污染、细光环的新复杂海报，冻结源后先验证此方法，失败则修方法而非降低标准；完整输出与两条路线独立审查仍是最终验收条件。工程夹具不计入实际海报生成回执。

### C53 文字方法替换

R38分段输出恢复了正文，但仍出现纸底、空心字形、字号和位置漂移。下一实验先采用显式nativeText真实字体渲染普通可辨认的水平印刷文字，PS用独立原生文字。不是把字体PNG冒称image_gen，也不从原图取字。记录字体文件SHA、实际字形度量、透明承载和自己的任务证明；小字号抗锯齿不是缺笔，字体样式/文字/间距/定位仍需实际源对照。复杂艺术字与薄透材质不由此宣称解决，不再为光学失败重复同义提示。

新轮次按当前真实新复杂源重新观察元素/文字/数字/结构；禁止直接复用旧源内容名称（R38误沿用R37波形图已作为规划失败保存）。每轮绑定source hash、独立路线真实输出和实际失败证据；同轮冻结源不变。工程字体样例、部分组成功或代码检查不是两条路线完整海报验收。新轮开工须记录实际代码与方法就绪状态，不能仅因旧状态写“运行中”就跳过已授权步骤。

C55替换字体冻结前的方法：R39真实普通与PS候选虽完整，但Calibri字形偏矮，不能仅凭可装入外框就选定该字体。新计划首次layout/prepare前，先记录实际可见墨迹尺寸（不把抗锯齿留白框当墨迹大小），用`scripts/review-native-fonts.mjs`对2–8个真实TTF/OTF与显式有限字号档做候选查看。字形须全部可用，字体摘要与源绑定；fit行用于几何候选排序，holdout行使用事前固定字号、不能用来排序或搜索。几何误差仅帮助比较，不能自动确认源字体或图层通过。查看实际源与每个候选的字形、字重及内部间距，再选字体并冻结实际字号/位置；没有匹配字体就记录残余外观差异，不用横向拉伸、描摹源字形或复制源像素兜底。诊断只写新目录，不修改旧job/recipe；旧轮只读回归不冒称新实际轮验收，下一实际轮仍用针对失败的新复杂图。

`scripts/reconstruction-experiment.ts` 是同一生产 HTTP 接口的轻量调用器，不是另一个重建实现。它不调用生成模型、不启动独立 Codex 推理进程、不发送对话消息，也不修改生产画布。每轮用独立数据目录、同一原图与冻结分层计划验证改动。预抠图仅为规划依据；验收对象始终是最终图层和最终合成与原图的对比。

## 最小操作

以下命令在仓库目录运行。`CODEX_THREAD_ID` 必须由真实当前 Codex 执行环境提供；不要复制旧对话 ID。将示例目录替换成当前轮次目录，将端口换成未被使用的非生产端口。

```powershell
node --import tsx scripts/reconstruction-experiment.ts init --data test-output/fidelity-loop/r01/data
node --import tsx scripts/reconstruction-experiment.ts start --data test-output/fidelity-loop/r01/data --port 18892
node --import tsx scripts/reconstruction-experiment.ts import --data test-output/fidelity-loop/r01/data --file C:/absolute/source.png
node --import tsx scripts/reconstruction-experiment.ts create --data test-output/fidelity-loop/r01/data --type plan --mode 3
node --import tsx scripts/reconstruction-experiment.ts claim --data test-output/fidelity-loop/r01/data
node --import tsx scripts/reconstruction-experiment.ts plan --data test-output/fidelity-loop/r01/data --input C:/absolute/plan.json
node --import tsx scripts/reconstruction-experiment.ts create --data test-output/fidelity-loop/r01/data --type layer
node --import tsx scripts/reconstruction-experiment.ts claim --data test-output/fidelity-loop/r01/data
node --import tsx scripts/reconstruction-experiment.ts packet --data test-output/fidelity-loop/r01/data
```

`plan.json` 使用真实原图像素坐标，由执行者查看图片后填写；从底到顶排列。例如：

```json
{"layers":[{"name":"背景","role":"background","box":[0,0,1000,1500],"opinion":"补全被前景遮挡区域"},{"name":"人物","role":"foreground","box":[100,200,700,1100],"opinion":"仅人物，外部透明"}]}
```

以上尺寸只展示格式，不是实际海报规划。`plan` 自动携带该任务冻结的 `baseVersion`。读取 `last-plan.json` 或 `packet` 返回文件获得真实图层 ID，不猜测 ID。

正常生成协议继续按当前 `RECONSTRUCTION.md` 执行。调用器不会代替 Codex 判断或跳过生成、审核、最终回传。例如：

```powershell
node --import tsx scripts/reconstruction-experiment.ts call --data test-output/fidelity-loop/r01/data --action generation --input C:/absolute/layout.json
node --import tsx scripts/reconstruction-experiment.ts call --data test-output/fidelity-loop/r01/data --action generation --input C:/absolute/prepare.json
```

输入 JSON 是对应接口的**直接请求体**（如 `{"action":"prepare",...}`），不是 MCP 的 `{input:...}` 包装；`taskId` 自动使用当前真实任务。默认记录完整响应到文件，只输出文件路径和身份信息，避免把大任务包反复装入上下文。需要查看全部响应可加 `--full`。`call` 支持 `generation / ps-rebuild / adobe / apply / fail / cancel / resume / plan`。

生成工具须由当前获授权的 Codex 执行者实际调用。后续 `register` 必须登记实际工具返回的原始文件，不能拿工作缩略图冒充原件。中断恢复使用同一 job 的原 requestId、generationId、冻结 frame 与登记提示词，不把旧输出伪装成新提示词生成的候选，不拷贝旧 registry 冒充新审核。

### 聊天预览与上下文预算

复杂测试源和生成层保留工具实际返回的完整原件；工作图不超过150万像素。聊天显示使用独立 JPEG 预览，文件不超过256KiB；`scripts/generated-image-preview.mjs` 检查真实任务、原件与工作图哈希、尺寸和预览字节。预览只供查看，正式登记与像素验证使用原件。

仅在实际输出已限制为上述预览时，生图响应可预留1MiB；不能对仍直接显示完整 PNG 的流程降低预留。预算脚本的16MiB是保守工作阈值，并非官方请求上限。估算未通过时限制新增图像输出并保存检查点，继续不依赖生图的修复；不要据此宣称服务故障或把整个改进循环变成用户必须解除的外部阻塞。禁止修改私有历史。测试复杂度、独立光效和一致性标准不随预览缩小而降低。

## 多路线与本地功能

### 已验收生成父素材作为新实验参考（C47）

新增 `import-parent --input <scope.json>`，仅用于已经初始化的当前隔离实验服务，不是生产生图API的新字段。scope必须逐项提供真实 `taskId/jobId/imageId/generationId/expectedWorkingHash/expectedSourceHash`；父件须为当前已领取任务内普通image_gen登记，逐元素matched、review accepted，无isolationProblem，不接受screen或派生件。没有这一验收就停止子层实验，不靠合并层数或少量定位点认定父件保真。

调用器回读当前generation状态、干净源、原件、工作文件、引用及对比摘要，按现有完整文件定位生成满幅参考，逐像素验证登记的原位预览，没有复制源RGB。只将该参考通过既有import-path导入新的隔离实验节点；完整工作/参考含透明均不超过150万像素，父原件保留。再次读取父任务及登记防止来源/审核/定位改变，并检查导入像素。导入前保存pending身份，回执不确定或回读失败保留节点与凭证，不自动重试创建第二个节点。后续create再次核验绑定及导入资产；失效不能创建子层任务。

这个节点是参考输入，不是已经完成的画布结果。凭证独立保存在当前实验记录中，不伪造画布parentId/sourceJobId或image_gen原件；原始完整海报仍是整体验收基准，不能只对生成父件验收子件而忽略累积偏差。现阶段是实验调用器能力，未宣称生产UI的原生父子来源链或任意递归拆分已完成。新轮必须冻结复合父件和子层分工，只运行明确计划的对象，不自动重做任何既有祖先后代。两路线各自生成和绑定父件，不互借参考或审核。

- 同一原图的 Codex、PS、不同版本对照分别使用独立实验目录，避免把某一路的漂移继承为另一路输入。
- `create --type photoshop` 建立 PS 任务；`call --action ps-rebuild ... --allow-adobe` 或 `call --action adobe ... --allow-adobe` 明确允许 Adobe 调用。仅操作实验新文档和副本，保护用户已打开文档。连接方式及凭证需单独配置到实验实例，不自动复制生产凭证。
- 预抠图使用 `create --type plan --mode 4`（或 2、5）后提交同样 `plan`。**非 3 模式提交 plan 会真实执行本地模型**，需加 `--allow-local-model`；不会自动下载模型或改变参数。
- 独立抠图/超分使用 `create --type cutout --allow-local-model` 或 `create --type upscale --allow-local-model`，属于本地队列，无需 claim。共享现有模型文件与运行时位置遵循生产实现，实验结果落入独立 data。不要把独立抠图产物偷偷用于普通生成路线替代正式重建。
- 可用 `create --input <job-options.json>` 传递生产 job 接口的额外参数，如 `layerIds`。`--image <真实节点ID>` 指定当前实验某个节点；不指定时继续使用最后导入的原图节点，不自动沿结果链执行。
- 每次操作默认当前 `experiment.json` 中的 jobId；`--job <真实ID>` 可以明确切换到同文档旧任务。

## 留存、续跑和计时

每个实验目录包含：

| 文件 | 用途 |
|---|---|
| `experiment.json` | 真实 taskId、目录、源图 SHA-256、导入节点与最近任务 ID |
| `experiment-events.jsonl` | 各次操作、HTTP 耗时、成功或错误、对应完整记录文件 |
| `experiment-calls/*.json` | 请求体、返回体、失败原因；未结束调用保留 pending 记录 |
| `last-<command>.json` | 最近一次命令的完整成功返回，或明确的 pending/failed 回执；失败不能读取为上一次成功 |
| `documents/.../jobs/.../generation/registry.json` | 生产协议生成登记、候选、定位与审核记录 |
| `service.log` | 该独立服务的日志 |

`status` 读取文档与队列；`snapshot` 另外为实验文档目录所有文件计算 SHA-256，保存可复核清单（大 PSD 较慢，应在检查点使用，避免每层反复执行）。

```powershell
node --import tsx scripts/reconstruction-experiment.ts status --data test-output/fidelity-loop/r01/data
node --import tsx scripts/reconstruction-experiment.ts snapshot --data test-output/fidelity-loop/r01/data
node --import tsx scripts/reconstruction-experiment.ts stop --data test-output/fidelity-loop/r01/data
```

同一服务仍运行时，重新执行 `claim` 不会重复领取 running 任务，可直接读取 packet/registry 续跑。失败调用只记录错误，不自动重复生图/重复写入。遇到超时或 pending，先读状态确认服务是否已完成，再决定重试；非幂等请求不能盲重试。

命令通过目录、任务身份与命令校验后，先使 `last-<command>.json` 标记 pending；失败改为 failed 并附错误和最近调用记录路径，成功保持接口原返回格式。旧成功记录仍保存在 `experiment-calls`，不会删除。读取最近结果必须先排除 pending/failed；进程中断留下 pending 也不代表服务操作失败或成功。身份校验拒绝不会改写其他任务的最近回执。

同一实验同一命令持有独占的 `last-<command>.lock.json`，重叠调用明确拒绝且不改前一回执；正常结束或报错仅释放自己的锁。若进程被强制终止，锁和 pending 留作中断证据。先核对锁的 taskId、command、PID，确认该进程确已终止，并查实际服务操作状态后，才显式清理该锁再继续；不能自动删除未知锁，也不能仅凭 pending 盲重试。不同命令也应顺序操作，因为它们共用实验任务选择状态。

**服务器重启仍遵守生产恢复规则：正在执行的任务可能转为 failed。** 使用显式生产 `resume` 接口恢复同一任务：

```powershell
node --import tsx scripts/reconstruction-experiment.ts call --data test-output/fidelity-loop/r01/data --action resume --input C:/absolute/resume.json
```

`resume.json` 如 `{"reason":"服务升级后继续已登记候选的合成检查"}`。如果任务已被取消，必须重新获得用户执行授权，并明确传入 `confirmCancelled:true`；不要自动撤销用户取消。接口只允许 layer/revise/photoshop 的 failed/cancelled 状态，核对当前任务、文档、原节点版本以及真实检查点文件；存在结果节点或其他执行任务则拒绝。completed 永不恢复。恢复不自动生图、不自动消息派发、不改变冻结快照或登记原件，原因与检查点数量写入 `resume-history.json`。后续原件哈希与质量检查仍由原生产协议执行，恢复成功不代表素材通过验收。

`stop` 不允许仍有 running/queued 的任务，避免人为破坏执行；可先用生产 cancel 接口明确取消实验任务。停止只针对该工具记录且实例身份验证通过的 PID，不删除任何实验数据。

HTTP 耗时不等于生图、人工评审或总任务耗时；外部生成工具的调用耗时需从实际工具记录单独统计。不要把这些 API 计时包装成完整用户等待时间。

## 改进循环与样本选择

字体只读诊断按实字大小检查大标题：字号范围与留出字号上限和原生单色字形合同一致为1000px，不再以100px字号或600px局部边长排除复杂标题。完整源与整张候选查看承载仍各限150万像素，最多121档有限字号搜索、留出字号固定、真实字体摘要及缺字拒绝均保留。每个候选在深浅两底完整显示，不因浅色字与旧灰底接近而不可见；预算不足则减少字体银行或观察范围，不裁不利字形或放宽预算。诊断仍只支持真实TTF/OTF；TTC容器不自动替代字体。几何误差很小也可能是错误字形，必须查看实际笔画与风化/变形，不能自动选择或写入冻结生产计划。R50旧标题框截到字尾及初次测量混入窗框亮边均作为规划/观察失败保留，后续只读诊断不会补改旧框或替生成失败洗白。

实验目的是改善插件。每轮必须生成一张新的复杂海报，把上一轮暴露的问题设置成新图的重点验证项；先写清失败、原因假设、准备保留/修改/删除的具体模块，以及能够否定该假设的检查。允许按已授权范围删掉无效步骤、改写规则或替换实现，保留原件、用户修改、真实任务身份和核心界面。

已保存的真实失败输出作只读基线和回归补充，不能代替当轮新图。新图须具有原复杂案例级别的多组文字、角色、产品、遮挡和独立光晕，并有针对上一轮失败的具体区域与验收项；不能用简单海报降低验证难度。涉及实际执行则建立当前对话的新独立job，不向旧job写入。普通与PS路线从同一干净原图独立开始，不让PS承接普通路线的失真来冒充对原图复刻。

每轮新海报及最终交叉验证须至少覆盖原案例的难点：多组大小/字形/变形不同的文字与微小文字、角色细发丝或服装软边、产品材质与比例、真实前后遮挡及纹理补全、接触阴影、独立镜头光晕/细光带、装饰图标/卡片和复杂背景。项目数量不是通过标准；缺少已知失败维度的简洁图只能用于局部机制检查，不能作为高一致性验收样本。

单个素材同一假设最多三种制作尝试，用来控制无效重试，不要求失败后一定凑满三次。达到上限后冻结候选及具体失败，停止该素材的无依据重试；这不是结束整轮或换图的条件。若其余冻结组件仍可执行，继续必要组件与两路真实复杂合成，以确认文字承载、遮挡和独立光效是否实际成立。失败候选可进入明确标记未验收的诊断副本，不能作为正式结果回传。只有确有证据表明继续合成不能增加诊断价值，才说明原因并结束该实验，再以具体实现/方法修改和可否定的新假设启动下一轮新复杂海报。不能在每轮仅做少数代表件后反复换图，不能把局部上限或阶段报告当整体目标完成。只有文件/来源/隔离/图层与最终合成均真实有效、复杂原案例及新复杂样本在两路线的独立盲评达到约定高一致性，才完成目标。没有修改/新证据却只改措辞重复生图，不算插件改进。

恢复循环时区分服务在线、job等待继续和实际模型/PS执行在途。以当前任务绑定的请求、真实生成原件、最终调用回执及审查报告校对检查点，记录明确的下一项可行动步骤；模型原件已返回但未登记时先登记，不重新生成。旧“运行中”字段不能成为跳过工作的依据，已结束的实际调用必须清除在途标记；暂无调用在途也不表示整体目标已完成。背景审核同时核对属于背景的承载材质（例如底部纸面）是否被误删，以及其他层拥有的墙上挂图/灯体是否残留；不透明及尺寸通过不能代替这两项语义检查。

真实PS组合中的screen素材须置于本层Pass Through逻辑组，使子层Screen能与组外背景混合；Normal父组会隔离子层混合，黑色承载可能遮挡其他组。置入时只修改该光效的父组并回读两级模式，不重排其他组、改变素材像素/文件变换或用户原文件。独立层看到灯体不等于整图中可见，须在已有不透明背景的真实PS渲染里查看。原有无背景的部分组合不足以判断该故障；修复前后使用相同源、素材和层序的新副本对照，后续新复杂海报再验证默认置入路径。参考：[Adobe关于组混合的说明](https://helpx.adobe.com/photoshop/using/layer-opacity-blending.html)。

有可辨定位点的物体，生成前从真实源图记录至少两处相距足够远的命名 anchors，用于自动对齐拒绝后的合法人工校正；不能生成后才补点或降低冻结目标守卫。无法可靠点选时明确记为缺少人工校正依据。r08 人物未记录 anchors，自动对齐拒绝后不能冒称已完成定位，这是实验规划缺项，不应通过放宽后端来掩盖。

局部替换先在真实基底和补片的原尺寸深浅底检查后冻结 mask、允许范围及哈希，验证范围外像素与原件保护。补片已明确失败仍可在独立副本验证替换机制，但须标为未接受候选；alpha 降低几级不能等同薄纱真正透底，保留纹理和去除旧背景是另两项实际视觉要求。缺失的区域守卫应修正协议，再用下一轮新复杂源生成前冻结；不能追溯给旧任务添加验收条件。

## 隔离与验收边界

- 数据根必须在仓库 `test-output/` 或系统临时目录 `layer-canvas-experiments/` 内，且有当前任务创建的实验标记；拒绝生产 `data/`、跨对话标记和越界目录链接。
- 客户端只读该实验的服务凭证，并核验 `/api/health` 的实例身份；不会自动 fallback 到生产服务。凭证不打印到结果。
- 启动服务时移除对话消息发送管道，不调用 dispatch/connect。实验队列可能显示“发送失败”，这是刻意隔离的自动通知；由已获授权执行者通过同一 claim 接口领取。它不证明生产自动唤醒功能成功或失败。
- 技术测试仅能证明协议和隔离性。最终质量必须独立查看最终图层、合成图、文字局部、透明边缘、光晕和原生 PSD。只在隔离服务器成功，不等于生产安装、右侧画布可见性和真实用户数据迁移均已验证。
- 调用器不实现盲评打分。评审者应接收随机匿名候选及原图，不接收修改说明，分别判断画面一致性和实际图层结构。

研究与改进循环：先核对真实失败和状态，再比较相关公开实现的方法及验收边界，选一项可证伪的修复落实到插件或删除错误行为。已有冻结复杂源可用于不改原件/请求/审核的本地诊断回放，必须明确不是新生图轮或新的正式结果；真正的新生成实验轮仍必须使用针对旧失败的新复杂源，同轮不换源。自动定位的留出检验见CONTRACT.md；它可在没有人工源点独审的情况下推进自动测量实验，不能替代最终独立视觉验收。不能仅增加提示词、层数或过程文件来宣称改进，也不能把外部Skill自称的效果当本插件实测。


## 失败依赖边界与验证覆盖（循环规则50）

父件未接受时仅停止依赖它的import-parent及子件任务，不能据此把原海报其他独立验证组全部跳过。下一轮源生成后，预先冻结至少人物复合父件、一组密集带字实体牌、一组密集信息栏与一件玻璃仪器的验证队列；两路线各自执行这些独立组和相关原位组合。父件失败写needs-revision及childBlocked，当前实验job保留到独立验证队列有真实完成/失败回执；依赖子件继续禁止。每组仍最多三种不同方法，同轮源与检查规则不变。部分组合不是完整海报，空组和未制作项必须在结案列出。

R36连续薄透材质修正仅为可证伪提示假设。下一轮若仍同类失败，不再叠加同义提示重试；先比较实际RGB、alpha、生成载体和来源边界，评估不同制作方法及真实PS的适用性，落实代码后再进入新复杂源实验。公网作者实现可提供方法依据，不能代替本插件真实结果。


## 当前生图回传的体积约束（C51）

复用scripts/generated-image-preview.mjs，不增加第二套显示协议。builtin image_gen仍由当前functions.exec调用；返回后先store完整实际对象但不显示native image_url，从output_hint记录真实工具原件路径与字节数。本轮source保存或组件原件register后，用review-image.mjs对完整工作图生成最多131072字节JPEG；source沿既有验证入口，组件用新--component入口绑定实际model-proof、当前登记record和完整view-proof，检查真实工具原件、复制原件、工作文件、请求及参考摘要，不允许用局部裁片作整件展示。

验证后由view_image读取该JPEG，确认data URL体积不超过验证上限，用generatedImage回传这个受限显示图，并在output_hint明确原image_gen路径及“仅显示预览，登记与像素检查使用原件”。不要先generatedImage完整tool返回对象，也不打印原件base64到上下文或命令行。boundedGeneratedResponse同样验证JPEG字节/hash与上限。组件显示验收不代表语义接受或全图通过。

工具已返回后，保存或登记/预览失败须保留实际路径和pending，从原件续作，不能重生图。只有实际回传限制已落实时，下一次调用才使用既有1MiB显示响应预留；不降低4MiB envelope或16MiB工作阈值，也不追改历史。旧全PNG历史仍需官方上下文管理。原件、alpha/PSD测量和150万工作像素约束不变。


## 密集文字遗漏修复与覆盖检查（C52）

R37两路线真实输出只留下底栏大标题与主图，正文、参数表和注脚消失。停止把整列密集文字与图表交给一个生成组的默认实验方法。新的复杂源须先按实际源将标题、图表、正文段落/参数表、注脚拆成独立语义组；正文每组2–4行或一个不可拆公式，每组均冻结源框、归属及预模型检查。不要拆成单字或用截图矩形作最终素材。可按需要用已有detailReferences或referenceScale作干净参考呈现，全部含留白仍遵守150万像素；增加参考不等于保字成功。

普通layout与PS plan的alphaChecks新增可选kind=occupied，字段为name、box、minAlpha、minPassingFraction，全部显式提供且box属于本组来源框。用于预计有本组墨迹/细线的区域，按实际放置PNG、真实PS组图统计达到minAlpha的像素比例。纸底须归独立组；occupied不能用于背景、screen或旧流程。与clear、transmissive及普通专属opaque分开，不默认添加，不追改已prepare任务。空正文不能标accepted；内容尚在但拼字、数值、字形、透视错误仍必须视觉标红。实色块可以满足数量，所以覆盖通过绝不能推定全文正确，也禁止为凑像素涂底色。诊断绑定实际原件、工作图、位置、规则和真实PS渲染摘要；修改任何一项都要按既有验证重新检查。

旧R37素材只用于只读遗漏回放，不能把事后新增范围写进旧任务，不能声称新规则已通过真实新图。下一轮同时验证分段生成是否保留正文与原位版式、字符间真透明，以及复杂角色、光效与玻璃失败项。若分段仍系统性丢字，评估现有真实PS原生文字/字体诊断及普通路线合法绘字方法；记录能力边界，不能偷贴原图或伪称原生文本成功。


## 光学组件唯一归属（C62，显式新计划）

R42真实双板失败，连续薄膜保留组外钢梁且黑白响应近零；C61只修复完整载体缩放，不能修复生成内容。下一次新复杂源实验改为将薄膜本体、实体印字/边框、可选水滴/划痕等表面细节分别建计划层；独立光效继续独立。普通layout及PS plan可显式填写opticalPart:{version:1,assemblyId,kind}，kind为thin-film、opaque-structure或surface-detail。每组件恰好一个薄膜件、至少一个实体件，可有多个细节/实体件；每件一个真实来源层，元素不能重复，冻结alignment/occlusion关系须连通全部成员。

仅新v4正常透明前景。每件须有本件之外clear区域；薄膜须有transmissive，不能带occupied/opaque印字规则；实体须有occupied（普通可opaque），不能带transmissive。数值继续显式冻结，不默认调整。背景、独立光效、nativeText v1普通实验、sourceProtection、aux-matte及packedBackdrop不能充当光学分件；C68仅显式nativeText v2真实印字可作为opticalPart v2 opaque-structure，不能充当膜、金属框或水滴。PS分件只允许generate或真正可编辑native，extract/hybrid/preserve不接受本实验声明；原生路线仍受原生内容/编辑能力的既有校验，计划不是真实执行。

首次prepare/已有素材或原生检查后，带分件的完整计划不能更改或删除分件归属；旧请求不能事后开启。普通及PS生成提示的structured/concise-edit格式自动列出同组件其他件及排除元素：薄膜移除组外背景RGB但覆盖保持连续，实体保留黑墨并清空薄膜填充，细节不重复薄膜/印字。请求绑定真实task/job/version及完整计划摘要；登记、素材、缓存合成及完成消费核验，计划或请求身份变化使旧审批/合成失效。无声明旧计划不补字段、不重写旧请求。

此修复只改变规划、提示和来源校验，不证明图像模型实现了分离。R42旧源/真实板件失败保留，不添加新规则重评旧结果。PS原生连续薄膜的路径与渐变制作仍是下一项待实现方法；未新增原生制作入口，不能把schema通过描述为PS重建通过。方法落实后才开始新复杂源R43，同轮源冻结；普通使用自身真实生成，PS必须自身真实制作和渲染，整体及独立审查仍待验收。


## 原生连续薄膜（C63，制作入口与工程验证）

PS新v4 native/shape/native-shape透明thin-film分件可冻结nativeFilm:{version:1,observation,knots,gradient:{angle,stops}}。闭合Bezier每结点为最终PS画布像素[inX,inY,anchorX,anchorY,outX,outY]，3–64点，锚点/控制点在冻结frame内。渐变2–8色标，position严格递增且端点0/1，color为整数RGB，alpha为1..254，angle为-180..180度。配方只记录事前人工观察和明确制作参数，不从源裁片取像素、不推断物理透射率；印字/实边与水滴等其他分件继续按C62排除。无配方的native thin-film声明不能当已实现制作。

canvas_ps_rebuild input:{action:"render-native-film",layerId,inputPsdPath}只接受本job PSD，完整工作画布含留白<=150万像素，目标LC组必须空。创建真正带可编辑vectorMask/原生渐变填充的独立源PSD，再由已配置AdobeConnector.executeScript让实际PS把形状置入输入的新副本并保存。原输入、其他组和用户已打开文档保留；对话task/job不符、非空目标或超预算在执行前拒绝。状态记录nativeFilms制作回执但不写accepted；冻结完整计划，重放仅在计划、输入、实际输出摘要未变时复用原回执，避免重复原生制作。

实际保存后的路径锚点/控制点（0.01像素序列化容差）、渐变颜色、透明度色标/位置、正常混合及唯一内容均回读校验；inspect-progress和最终PSD结构检查再次核验原生组，不能用隐藏层、位图、额外印字、挖孔路径或修改配方后文件冒充。仍必须inspect真实PS透明组PNG的clear/transmissive规则、深浅底和原图外观；工程PSD缓存与模拟脚本不证明PS设备行为或视觉一致性。普通路线继续自己的真实image_gen，不把原生薄膜输出冒充image_gen。

C63已通过工程结构/接口及模拟Adobe执行测试；其“模拟”不是实际PS回执。下一次R43必须新复杂源，源冻结后事前观察填写配方，执行真实Photoshop制作/渲染并对照，普通单独真实生成。两路线完整海报输出与独立审查尚未验收。

## PS默认渐变字段回读兼容（C64，R43实际失败后修复）

R43真实Photoshop27.6在新副本制作了闭合原生路径与透明渐变，原输入和用户文档数量1→1保持；C63严格要求vectorFill.align显式true，实际PS保存及ActionDescriptor只读查询均省略align、angle=0、scale=100%等默认字段，因此首次制作回读400。实际Bezier序列、颜色和透明度色标均保留，并非改图或生成失败。原400回执、实际PS新文件及参数只读报告保留。

C64仅使本原生填充实现的缺失默认align按true解释，与已有缺失angle=0、scale=1解释一致；显式false对齐、非零错角、错缩放、反向、路径/色标修改仍拒绝。默认项兼容基于本次PS27.6保存行为，是受实际alpha/视觉验证约束的解释，不等于确认物理透射率或所有PS版本行为。未改源、已冻结配方、RGB/alpha文件、区域规则或阈值；继续从已保存实际PSD执行inspect-progress，不重复制作或生图，最终仍须完整PS渲染及高一致性审核。

## 从原生薄膜准备文件恢复（C65）

真实R43已保存原生薄膜，但默认字段回读失败使nativeFilms尚未提交；旧resume仅认识登记/暂存/位图素材/完整inspect，不能升级后复用该原生文件。新v4 PS同job resume可显式提供nativeArtifactPath，必须是本job范围内PSD，工作画布<=150万像素，原节点和版本未改且没有其他执行job/已提交结果；冻结PS计划须有效，文件实际可见nativeFilm路径与渐变匹配冻结配方。空组、异任务文件、像素占位、错误原生配方或未确认取消仍不能恢复。

resume只读文件并把匹配的原生准备层及文件摘要/冻结计划记入resume-history，恢复同一个job；不调用模型/PS、不登记image_gen、不创建结果节点、不标accepted。准备不是实际PS执行或视觉通过；后续inspect-progress必须实际PS渲染并检查alpha/外观。带原生恢复历史的光学计划继续冻结，不能借恢复改元素归属或检查阈值。实验维护先通过公开fail记录服务升级原因，停止自己的空闲服务、升级后resume同job并指定原生文件；禁止杀正在执行的任务或修改私有会话历史。R43源与已保存原生输出保留，不能把维护中断误报为整图视觉验收失败/通过。

C66：显式opticalPart的新prepare只采用已冻结分件归属说明，删除通用混合材质段（保留水滴/刻痕、实框/铰链、印字及同组后方实体例子），避免与薄膜/实体/细节唯一归属冲突。非分件规则、数值alpha检查与已存请求不改；提示一致不等于真实输出验收。R43普通实际薄膜仍是needs-revision，PS真实薄膜区域通过仍不代表整图通过。


## C67：光学组件共同源定位与规划复核

R43两路真实三件组合已暴露膜边不贴框、刻度约3像素偏移及水珠越界；同框和关系连通不足以约束相对几何。新计划可显式采用opticalPart.version:2，仍用现有anchors字段：同组件全部成员至少三个名称/位置独立且不全共线的源观察点，名称、坐标和观察必须一致，顺序无关，不能混用v1/v2。点须来自当前源中可辨认特征，框/膜不同边缘不能强行当成同一特征；参照其他件只用于定位，不能复制其像素。既有prepare将这些点映射到完整参考载体，align仍只允许生成前冻结目标；数值alpha、身份与完整计划冻结不放宽。v1及无声明旧计划不迁移、不新增默认定位点。

背景归属在首次冻结前单独复核：连续环境属于背景时，不能套用透明前景的“删除透见钢梁、电缆、墙面”排除模板；仅排除独立人物、物体、文字及光效，并补齐其遮挡。该复核是执行者对实际源和计划的观察，后台不靠关键词猜环境归属或静默改写排除项。失败旧计划保持原样，不能追改已冻结R43请求来宣称修复。

共同定位点是可执行的参考约束，不是像素一致性证据。PS原生薄膜还须按当前源观察其实际边界、冻结独立路径/渐变并真实渲染，与自身框/印字/细节组合检验；普通模型件使用自身当前对话真实生成；首次prepare前显式选择的原生配方件使用自身后台真实渲染身份，普通连续膜可选C78，不能冒称image_gen或追改旧任务。组件失败可结束有充分双路实际证据的实验轮，保留未做层及未完成整图/独审记录，再修复并使用新复杂源；普通用户完整任务与两路整体验收目标不因此结束。代码测试不等于实际图像验证。


## C68：真实字体按冻结源平面渲染

R44实际两路框字缩小偏移、黑刻度均0/18，三点提示不能稳定实际字形；普通连续膜复制遮挡缺口，PS原生膜alpha通过但组合未贴合。C68先替换平面印字的模型独立重画：扩展既有显式nativeText为v2仿射平面字形，不添加新默认入口；记录字体、变换、局部墨迹框、实际墨迹四角及完整task/job/request/recipe/output证明，不能外部register、事后换变换或拉伸超框文字。旧v1仍水平；v2只允许非镜像可逆仿射，不处理透视、弯曲、连续膜、金属框或水滴。

原生字体可作为v2光学组件中的独立印字，继续共享事前源anchors；不能把膜与印字混在一件。只读字体诊断在同一冻结平面上比较有限真实字体，留出行字号不搜索；实际源像素只在诊断SOURCE格出现，不能作为字体产物。普通产物如实为native-font-renderer位图，PS仍须自己的真实可编辑文字文件与回执。新复杂源针对R44平面漂移验证，冻结整图后再冻结字体计划；方法测试不是实际视觉验收，两路完整整图与独立审查尚待完成。
# C70 只读字体比较承载修复

R46实际源靠近右缘时，较宽候选超出原有“观察局部+4px”的诊断框，使整个字体比较拒绝制作。现以全部候选的完整映射框并集生成查看承载，保留不匹配的宽字形；源读取仍仅限事前冻结的局部，留出字号、候选银行、排名及源文件不变。整张比较图仍不超过150万像素、JPEG不超过128KiB，预算不足直接拒绝；诊断图不得成为模型参考或生产素材。保存原失败和修复后的比较，不以诊断成功冒称字形/整图验收。

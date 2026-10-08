# 接口与数据约定

显式新配方支持截边后的五至八点凸直线膜轮廓：普通`nativeGeometry.version:3`的单个薄膜shape使用`outer`五至八点、实色和alpha渐变；PS使用`nativeFilm.version:2`的五至八个直线knots及显式椭圆cutouts。孔须解析检查严格内含且不重叠；凹形、星形、自交、退化、越框和曲线带孔均拒绝。普通仍需独立v2光学分件及clear/transmissive，PS仍为native薄膜并回读可编辑subtract路径。旧v1/v2普通四角和PS v1带孔四角不放宽，新配方首次prepare前冻结，不回填历史任务。不生成源mask或轮廓描摹，不改变150万完整工作像素预算；实测透明渐变与几何结构通过不代表源外观或真实PS整体验收。

新v4背景prepare的两种提示格式只要求保留该背景元素清单拥有的环境和材质，替换通用前景字形保留指令。排除图文即使印在保留底材上也须移除并补连续底材；本层明确拥有的文字和细线仍保留。不新增参数或处理源像素，不改旧请求、用户意见和登记身份。背景实际隔离及整图一致性仍需验收，见C80实验说明。

普通nativeGeometry v2薄膜shape与PS nativeFilm可事前声明cutouts:[{name,center:[x,y],radiusX,radiusY,angle}]，只支持完全内含于直线凸四边形的独立椭圆圆窗。孔承载框保守不相交，不从源图复制mask；冻结clear孔和transmissive膜检查，普通RGBA证明native-tinted-film-cutouts-v3，PS可编辑subtract路径须真实PS回读/渲染。无cutouts旧行为兼容，旧冻结任务不追改。详情见RECONSTRUCTION_EXPERIMENTS.md的C79。

普通v4的显式`nativeGeometry`现支持配方v1实体四边形和v2单个无孔连续薄膜。v2须独立opticalPart v2 thin-film、clear与transmissive检查，形状实色RGB加事前冻结线性alpha渐变；调用prepare/render-native-geometry，真实身份native-geometry-renderer，证明算法native-tinted-film-quadrilateral-v2。只制作来源无像素复制的普通透明位图，不推断物理透射率或自动验收；PS实体几何入口仅配方v1，PS薄膜继续nativeFilm。详细参数及旧任务冻结边界见RECONSTRUCTION_EXPERIMENTS.md的C78。

新普通v4可在layout首次prepare前显式冻结nativeGeometry简单实色凸四边形/透明孔（共享shared/native-geometry.ts严格配方），仅独立v2实体单层normal前景。prepare返回native-geometry角色，render-native-geometry内部生成完整RGBA位图并登记kind=native-geometry、receipt.tool=native-geometry-renderer及nativeGeometryProof。完整配方/请求/参考哈希/真实任务/原文件/固定位置均校验；外部register、alpha/字体/光效/背景混用、事后改计划与重新align均拒绝。普通是位图，PS原生四边形另需自己nativeGeometry计划、render-native-geometry实际PS执行和metadata/透明孔/源对照，不借用普通证据或冒称image_gen。旧无字段计划保持不变，150万含留白预算和完整输出/视觉验收要求保持。

C61缩放修复：真实R42的C60输出失败后，工程夹具确认完整双板Lanczos3跨中线插值会使正确黑白配对产生866个不相容像素（最大误差4）。新请求须在首次prepare前显式packedBackdrop.version:2及normalization:'whole-carrier-nearest-v1'，只对完整载体执行两板共享的唯一像素中心索引表最近邻预算缩小、偶数工作宽和固定中线；同一索引表复制原件两板对应像素，避免通用resize采样相位差；不对单板找边界、重新配准、调alpha或放宽原方程。可能损失少量细线采样，仍须真实原尺寸/几何/小字审核。旧version1、R42原件/工作件/失败回执保持原Lanczos3，不重解释为新方法。新kernel无法修复真实模型原件中的前景漂移或残留环境；不能把工程零误差当R42或整图通过。

C60单次双板实验：新普通v4单normal透明层可在首次prepare前冻结packedBackdrop:{version:1,arrangement:'black-left-white-right',panelSize:{width,height}}，同时冻结clear/transmissive/occupied（或opaque）区域。不能与旧matte、字体、背景保护、光效或周边/缩放/细节参考混用；panel比例须匹配完整设计frame。prepare返回一张左黑右白、无间隔/标签的完整carrier请求与transparent_background:false。两板总工作像素含留白≤150万，不是每板分别150万。真实生成原件先全图验证单张8位PNG/alpha255/偶数宽及完整比例；原件不变，只在超预算时统一缩小完整carrier，中线固定，禁止内容检测、单板配准、拉伸或换图。register返回packedId和intermediateOnly，不能直接合成/完成。derive-packed-alpha传packedId及expectedCarrierHash（working.hash），从该真实生成carrier固定中线拆板并运行同一黑白解混方程；不从源图或预抠取得最终像素。板件来源是generated-panel，只有carrier是一次image_gen，最终kind/receipt为derived-packed-alpha，不能冒称两次模型输出或单层生图原件。解混前验证双板clear区域；不相容保存真实绑定failure.json与板件，0新增RGBA，拒绝重复同请求/同方法prepare及同carrier派生。成功派生也须以实际原件/完整carrier/板件/固定方程重新认证，source/layout/request/尺寸/位置/文件变化使已有review/composite/apply失效；不能通过派生后定位或调alpha逃避失败。一份文件并不证明两个前景一致，工程通过不是实际视觉接受。此版本只适用普通路线；PS仍须自己的真实素材与原生渲染，不借用普通结果冒充PS独立生成。

C59失败循环约束：双背景固定解混出现真实不相容诊断时，后台在本job保存failure.json和绑定task/job/base/aux/双工作摘要的matteFailures，生成层数组不新增RGBA。写入前再次CAS和双来源文件校验，旧任务及其他组不迁移。相同双输入不重复派生；同一基底和冻结binding已有失败时不再prepare白底请求，须先改变前景表示或联合生成方法。R41真实两次RGB并未保持同一前景，普通拒绝891345/1497760像素；PS独立透明材质实际原生置入与渲染仍薄透失败。不得把黑底空隙通过、原件登记、空PSD组或测试通过当完整验收，不重复两张RGB提示。


C58双背景实验：新普通v4首次prepare前冻结allowAuxMatte、clear/transmissive及固有黑印字的occupied/opaque区域，matteBackdrop:{version:2,color:"#000000",space:"srgb-byte-v1"}。第一份真实输出是彩色黑底RGB中间件；第二份aux prepare必须明确matteEncoding:"white-composite-rgb8-v1"，生成相同几何/颜色的彩色白底RGB，不再预测灰度覆盖图。两份完整原件均先验证8位sRGB PNG及alpha255，再保留原件并按150万预算归一；白底保留彩色通道，不转灰。派生要求完整工作件同尺寸，不自动配准/裁切/补边；固定aByte=round(255-mean(whiteRGB-blackRGB))、F=blackRGB/(aByte/255)，逐像素再合成两份实际RGB最大误差≤2，任何不相容像素拒绝，不调alpha或放宽标准。零alpha RGB清零，黑色固有印字也能恢复高覆盖。黑/白底分别按冻结clear区域检查原位底色±2及原合格比例；occupied/opaque仍需独立检查，方程本身不能发现两次都省略的内容。算法black-white-composite-unmix-v1、双来源角色与文件摘要必须保持；原始RGB和aux均不可直接作为最终层。旧version1中灰与缺字段算法不迁移；PS仍不支持本实验。它是工程候选，真实生成会否保持前景未知，数值相容不代表物理光学或海报一致性。


C57：已知中灰实验在辅助prepare前按真实放置RGB检查冻结clear区域是否满足#808080±2，采用原clear合格比例；不满足则不创建辅助请求。解混相容诊断在完整carrier上区分零alpha底色偏差与非空材质覆盖不足/几何错误，最低可行alpha只作解释，不改matte。旧无matteBackdrop记录保持原必要条件，新增检查不放宽C56误差或语义验收。

C56：普通新v4材质layer可事前冻结`matteBackdrop:{version:1,color:"#808080",space:"srgb-byte-v1"}`；必须同时allowAuxMatte、clear/transmissive，不能与文字、背景或光效混用。prepare自身不透明中灰RGB，register记录`matte-rgb-base`及从完整原件重算的alpha255证明；中间件不可作为正式图层。独立matte后derive-alpha使用`known-backdrop-unmix-gray-v2`固定恢复RGB/alpha，记录逐像素再合成≤2与RGBA编码证明，错误拒绝且保留原件。没有字段的旧记录沿用原算法；禁止事后开启或改变底色，PS明确unsupported。相容性与数值检查不构成视觉验收，详见重建实验文档。

C54：PS `inspect-progress`在新v4计划中也从真实PSD读取已有原生组，检查实际可见文字/路径与文字目标，不再只列已ready位图素材。空组、隐藏/零透明占位不算ready，像素或错字不能冒称原生。已ready原生与位图共同输出透明缩略图、深浅底和已冻结区域alpha诊断，原生文字报告绑定实际PS读回；源PSD在检查期间变动则拒绝沿用。进度结果保持previewOnly，不填充materials、不改变审核状态，也不把未做组或整图声明为通过。

普通v4的显式字体渲染窄例外：仅新layout单层normal透明前景可声明`nativeText`，见shared/native-text.ts。字体文件/摘要、真实可见文字、字号、颜色和字形框在首次prepare前冻结；v1框为最终画布墨迹框，v2框为局部墨迹框，另冻结源观察的六项仿射transform及transformObservation。v2只支持有限、可逆、不镜像的倾斜/斜切，完整墨迹四角须位于最终frame，不支持透视、弯曲或事后拟合。不能用于背景、光效、matte或PS生图项，也不自动推断文字/字体。prepare标记native-text后只能render-native-text(requestId)，不接收外部register。后台记录native-font-renderer、字体实际度量及task/job/request/recipe/output绑定证明，v2再核对冻结变换与实际墨迹四角；普通文字仍为透明位图。TTF/OTF Unicode cmap缺字、彩色字体、超框/超预算报错，不静默替代或拉伸。只有v2真实印字可加入opticalPart v2 opaque-structure，不制作金属框、连续膜或水滴。原件、工作件、深浅底、登记、alpha、逐元素与整图审核沿用现有协议；字体或证明改变使合成/交付失效，后端字体产物及像素别名不能冒称image_gen。PS原生文字使用独立的真实PS文字路线。此实验接口没有增加UI按钮，不扩大默认生成和预抠引用范围。

新`generation prepare`可选`referenceContext:{marginPixels,observation}`，仅v4普通normal透明前景及已声明独立screen光效（普通或PS generate/hybrid）。人工确认干净局部框裁断原图实际可见笔画/轮廓后，显式指定1至128最终整图像素边距；后台扩大本次carrier，从当前干净源重新取得对应周边，不以旧裁片补空白伪称完整参考。第一张为完整周边承载，第二张保留旧框局部，冻结frame/定位点/归属不改；旧请求无字段保持原样。周边属于其他层的内容仍须删除，整图外按surface补中性留白：normal真透明、screen纯黑，不编造画外内容。背景、源保护、aux-matte及旧流程拒绝；screen必须已冻结为独立light/light-effect；没有已确认当前源尺寸映射时不退回旧原图。

周边请求冻结实际原像素crop及sourceHash、首图path/hash、carrierFrame、实际请求尺寸和观察依据。干净裁片缓存包含源内容摘要；同路径源更新产生新裁片，旧参考不覆盖。源/有序参考/登记状态/Job及PS完整计划在异步准备结束再次核实，变化时不保存旧请求或回滚新内容。周边参考及相同RGBA重编码别名禁止登记为image_gen。原件仍按完整carrier定位，150万生成/工作像素预算含透明留白；结构检查不证明视觉重建成功。

周边请求的登记、定位后及双来源alpha派生审核，使用完整carrier视窗与第一张干净周边参考，记录`comparisonFrame`和`comparisonReferencePath`；不能再按旧设计框裁掉待检查的框外笔画。设计frame、原件、工作alpha及放置坐标不因此改变。无周边字段的旧请求沿用原视窗，不追改历史对比图和已登记审核。

首次周边prepare的源定位点可位于设计框外，但必须落在本次完整carrier与真实整图canvas的交集内；不能定位到画外透明留白或任意扩大范围。请求冻结这些整图源坐标后，align只从请求取得该范围，并逐点核对anchorNames和原目标坐标；相对于设计框的局部target因此可为负数或超过框宽高。仍只允许统一正比例缩放和平移，不移动冻结目标或追改旧请求；无referenceContext继续限制在设计框内。

PS完整素材置入使用本job内的短文件名。素材路径达到260字符时，同job内建立字节完全相同的短路径副本供ExtendScript读取，执行结束再次核实原素材和副本摘要；不改登记来源、alpha或placement，不冒充新生图。任务目录本身仍过长则在调用Adobe前明确拒绝，保留原件与失败文件，不迁移用户目录。

`generation prepare`可选`detailReferences:[{name,box,observation}]`，普通与PS生成共用。box为最终整图坐标，须在canvas和冻结本层frame内；最多3个不同名称，实际干净局部采样合计≤262144像素。不接收外部路径，不缩放、标注或分离，crop及sourceHash随请求冻结；PNG追加在已有有序referencePaths之后，第一张完整构图依据保持不变。提示同时说明细节的整图及本次生成坐标，登记仍校验所有参考摘要。辅助matte禁止追加；旧请求缺字段保持缺失。这是参考包装，不能用于拼贴最终图层，也不能代替真实父件或整图审核；生成工作文件150万像素预算保持不变。

细节prepare与register的异步处理后，重新核实本任务generation registry、Job、参考文件；PS另核实完整plan（含排除项与relations），不能仅比Job或单层计划。并发授权更新须保留，旧请求/登记不提交；已写的诊断参考或原件不代表成功，不覆盖现有业务记录。已冻结细节文件及相同RGBA重编码别名不能登记为image_gen。

精确字段以 server/types.ts、server/validation.ts、web/types.ts 为准，端点以 server/index.ts 与 bridge/mcp.ts 为准；本文件用于智能体快速定位。

已有干净裁片缓存须与同次捕获源字节按已确认frame重新导出的PNG逐字节一致；不能只信文件存在或源摘要构成的文件名。缓存内容不一致（含重编码）时拒绝prepare，保留旧文件与已冻结引用，不覆盖或删除；因此缓存目录不支持外部改写。候选审核、结构检查和真实输出仍分别记录。

## 数据

独立超分任务 `type: upscale`：冻结 `job.upscale` 与当前 `snapshot`；不接受 `layerIds/useOriginal/useVectorLayers`，由本地队列执行，不进入 Codex claim/apply。`GET /api/upscale-status` 检查模型/CUDA，`GET/PUT /api/upscale-defaults` 读写默认值。结果状态 `upscaled`，精确宽高为输入乘倍率。正式位图分层节点逐层超分，保持层ID和缩放后标注，`psdSource/artifactUrl` 指向已回读校验的新PSD；其余节点输出单张位图。源透明度独立缩放；预分层以干净输入为准。具体参数范围见 `shared/upscale.ts`，分层实现见 `server/upscale-layers.ts` 与 `server/upscale-psd.ts`。

- Document：id、taskId、revision、images、settings、layout、updatedAt。
- settings.psdMode：2、3、4（BiRefNet）或5（Lucida）；vectorEngine：vectorizerCom、recraft、vectorizer、vectorizer302。
- CanvasImage：id、source（不可替换）、url、width/height、画布x/y、layers、vectorLayers、annotations、opinion、version、status、parentId/sourceJobId等来源信息。
- Layer：id/name/url、图片坐标与尺寸、visible/opacity、opinion、keep/rebuild、raster/text/vector类型、可选cutoutBox（未扩边的原始物体框）及PSD原生信息。数组顺序从底到顶。
- Annotation：image内归属、layerId或null、arrow/ellipse/box/pen/text、points、text、颜色、线宽、字号/字重、笔刷大小/透明度。允许图外坐标，不跟随浏览器缩放改写。
- Job：taskId/documentId/imageId、type、status、version、snapshot、可选layerIds、引擎、发送状态和输出结果。冻结输入不随前端切换改变。

## 浏览器入口

- GET /api/document?taskId=...：读取或创建该对话文档。
- PUT /api/document/:id：document和expectedRevision；冲突409。
- POST /api/document/:id/import：multipart files；PNG/JPEG/WebP/PSD/SVG。
- GET /api/document/:id/images/:imageId/reference：只读原图url及complete，不返回本机路径。
- POST /api/document/:id/jobs：当前imageId、type、可选layerIds/mode/engine/useVectorLayers等。
- GET /api/document/:id/jobs；POST /api/jobs/:id/cancel。
- GET /api/document/:id/export：imageId、format与view；UI原图对比不改变导出。
- GET/PUT /api/settings：只读脱敏状态/写入当前服务商凭据。

/api/health 公开；其余网页请求需本机访问令牌并符合Host/Origin要求。资产必须属于对应文档，不能跨文档引用。

## 可信 MCP 入口

PS重建新增 `canvas_ps_rebuild({taskId,jobId,input})`，对应 `/api/jobs/:id/ps-rebuild`：plan/material/status/inspect/review/review-composite。settings.photoshop冻结到Job.photoshop，plan.canvas允许统一等比目标尺寸；已有frame按比例变换。每个逻辑层对应唯一顶层LC_<layerId>真实分组；仅隐藏LC_REFERENCE允许作未映射原图参考。完成必须回传inspect生成的未更改PSD副本并有完整审查。普通分层与PS均固定150万像素预算，旧设置自动归一化。

CanvasImage.nativePsd保存实际PS合成URL和逻辑层→原生分组映射。缩略图不是可重新拼装的PSD；renderImage使用PS合成，exportPsd直接返回原生文件。PUT显隐/透明度/排序经PS副本更新，回读验证后再提交；失败保留上一版。原生节点revise/layer自动路由同一PS重建任务，防止丢原生效果。新工具暂未刷新可使用bridge/cli.ts的canvas_ps_rebuild入口。详细执行协议见插件技能PHOTOSHOP.md及docs/PHOTOSHOP_REBUILD.md。

内部端点另需 X-Canvas-Bridge，并验证真实taskId。通过 canvas_open / canvas_import / 请求领取、packet、plan、apply、fail 等工具操作；完整清单从 MCP listTools 读取。

领取包 sourcePath 是当前节点干净输入，originalSourcePath 为来源链可用参考，originalReference.complete 说明是否找到了根节点。参考只读，不继承上游意见；当前节点和本次意见优先。layers 仅对已完成的真实图层提供素材路径；预览层仅含名称、归属、坐标、顺序及意见，coordinateAnnotations 提供坐标与独立选区。

`referencePolicy` 由 `shared/reconstruction-policy.ts` 统一生成，也附在 Adobe 交接提示中。每次 Codex 生图/编辑必须携带该原则：最初导入原图约束未要求变化的视觉内容，保留当前节点已确认修改，本次意见仅在对应作用域覆盖；补全按周边材质/光照/透视延续。缺失或不完整参考必须明示，最终须核对实际合成结果，不以提示词代替验证。此字段不改变冻结任务归属，不触发上游执行。

apply必须带对应baseVersion及真实输出文件。服务核验尺寸、格式、图层身份、归属和任务状态；正式结果分支为新节点，保留源节点及后来编辑。取消/已结束请求不重复执行。仅预分层计划可更新源节点计划状态。

## Python

worker.py status查询模型；segment读取实际图片，输出透明预览及JSON元数据。当前矢量化执行不使用本地模型。独立蒙版不是生图工具硬约束；工具不支持蒙版时只能作为定位参考。


## PS重建协议v2

`plan.layers[].surface`必填：transparent前景、opaque完整背景、screen黑底光效。非背景禁止opaque，非光效禁止screen；背景禁止extract，bitmap禁止native；native不能声明纯pixels。默认generate素材必须generated，旧协议hybrid同样须generated。新任务的显式背景保护派生使用下述独立source-protected凭证，不能冒充image_gen。可选extract仍允许真实透明物体分离与补遮挡。

新流程v4（内部`reconstructionVersion=3`）仅在`allowExtraction`开启且`route=hybrid`、`surface=transparent`时，允许真正extracted物体先作完整基底，再接受当前任务真实registered generated补丁的`repair`。提取基底必须绑定当前干净来源、原件与预算工作件、完整carrier位置和计划，明确记录提取与遮挡方法，不伪造生成登记。生成补丁仍走prepare/register，完整PSD嵌入基底、来源链及最终状态CAS核验继续保留。未开启提取、纯generate、opaque背景及其他单一路线不增加这个例外；提取并不自动证明发丝/玻璃/薄纱视觉正确。

可见原生文字用`textTargets:[{layerName,text,box}]`声明参考字形边界。mixed必须有可见原生文字/路径。像素文字退回需`nativeFallback:{reason,attempts:[{method,observation,evidencePath}]}`，证据在本任务目录。`fit-text`按PS实际字形边界拟合，输出新PSD，不覆盖输入；支持字体/初始字号/字距/颜色/追加旋转/warp。拟合不证明字体或艺术效果匹配。

material须`evidence`：generated携带`generation:{tool:'image_gen',outputPath,referencePaths,prompt}`，引用仅允许本任务干净输入及局部参考；extracted携带`extraction:{method,occlusion}`。记录返回/参考摘要，但不能独立验证宿主调用历史或内部模型。实际alpha和解码矩形裁片副本检查在超分前进行，不改变主体或裁透明边。

inspect以PS实际渲染输出透明、深/浅底逐组PNG，检查图层框内alpha；opaque背景不允许透明空洞。quality记录文字边界/字体/颜色/warp。超过20%目标边界且大于8像素的原生文字偏差不能报accepted，可经不同方法尝试后needs-revision；仅捕获明显定位错误，不是生图视觉漂移阈值。

review须`checks:{isolation,occlusion,appearance,text?}`，text须检查字形、位置、颜色和变形/样式。PSD或检查渲染修改使验收失效。仍漂移沿用红标继续；缺素材/无效裁片不可冒充完成。新状态version=2；已完成历史不迁移，未完成旧协议须重提计划，保留文件。

## 精细抠图与默认参数

shared/cutout.ts 是 Web/服务共用的校验和默认值。settings.cutoutOptions 按 coarse / birefnet / lucida 保存；Job.cutoutOptions 提交时深拷贝冻结，旧任务缺字段时取工厂值。新画布默认方案4，已有2/3不强制切换。GET/PUT /api/cutout-defaults 读写 data/cutout-defaults.json，仅保存参数，不包含图片或凭据。保存当前文档和全局默认由前端分别提交。

方案2/4/5的 plan 从干净输入运行对应模型供用户预览，方案3只读取干净图，提交名称、box（整数 x/y/宽/高）、role、opinion 与底到顶顺序；禁止生图或抠图，拒绝 path/url/svg/previewUrl，服务创建 kind=plan 的无像素层。plan 提交即完成预分层任务，不自动进入 layer。所有模式在真实 layer 阶段统一为原图与结构化标注驱动的生成重建。generationInputs.allowedImagePaths 明确列出允许引用的干净原图、当前输入和已完成真实图层；任务包所有预览层均移除 path/url/previewUrl/svg 等像素入口，仅留语义与坐标。canvas_prepare_cutouts 旧入口返回409，真实分层不再运行本地抠图；不再提供像素拼回脚本入口。提交显式预览或与输入预览解码像素相同的副本将拒绝，即使改名或重编码也不接受。该检查能识别直接复用，不能证明任意重绘或拼接的来源；实际生图引用及生成后处理仍须按技能验证。

segment --model coarse|birefnet|lucida --options <JSON文件>；精细模型仅加载本地固定版本、校验过的代码/权重，离线推理。输出携带实际执行设备/精度。角色背景使用前景蒙版并集反集作为待补全预览，不把它当完整背景。

## 图层画幅约束

普通位图层支持 `blendMode: normal | screen`，缺省为normal。v4生成layout仅允许声明 `content: light-effect` 的非背景层使用screen，后续prepare/登记/审核/回传从冻结layout继承，不允许临时改模式。黑底screen光效是合法素材，不能误当不透明背景裁片；支持使用原参考中的冻结定位点统一缩放和平移，保留完整黑底及滤色预览，暂不自动匹配。背景和隔离失败素材仍禁止定位。审核合成、画布、PNG、PSD和分层超分必须保留同一模式。包含screen的普通结果不能直接导出SVG，需先完成实际矢量化。普通PSD导入遇到独立蒙版、不能表达的组混合/透明度或其他混合模式明确拒绝，不能忽略这些属性后继续拼接。原生PS结果继续使用真实PS预览及原PSD，不经普通合成器替代。

普通v4不透明背景仅在完整原件和工作图实际alpha均完全不透明、原件的整数等比投影已覆盖冻结画幅、预算工作图留下单行或单列1像素缺口时，登记`backgroundPadding`并等比缩放后复制相邻边缘像素补齐。`backgroundOpacity`记录原件原始位深的alpha最小值和完全不透明值，并绑定原件摘要；预算缩小或8位转换后消失的稀疏弱alpha仍拒收。已有未完成补边候选缺少或不匹配这项原件证据时，审核、合成及回传有效性检查拒绝旧accepted缓存，须重新登记/审核；历史终态节点不回写。原件与150万以内工作图保留不变；登记放置预览、审核合成、最终PNG和PSD使用相同物化结果。真实原件比例缺口即使被工作图取整掩盖，也不能标为accepted；透明背景不补边。透明前景、screen和原生PS不走此分支，不裁完整边界、不分别拉伸宽高。渲染版本、补边参数和原件不透明证据纳入合成签名，旧审批不得授权改变后的像素。大于1输出像素的缺口仍需重新生成或明确标红。

普通v4的normal透明前景可在`layout.layers[].alphaChecks`显式冻结命名区域约束（可选，不迁移旧无约束任务）。`box=[x,y,width,height]`始终为当前图片局部整数像素，须位于图片及本组来源层冻结框内；不是屏幕、生成文件或其他层坐标。每组最多20项，名称不重复，全部数值阈值必填：`clear`以`maxAlpha`(0–254)与`minPassingFraction`(0–1且非0)要求可见环境孔隙保持清空；`transmissive`还要求`minAlpha`(1–254且不大于maxAlpha)与`minBackgroundResponse`(0–255且非0)，按同时满足alpha区间与响应下限的区域像素比例判断。全透明空洞不能冒充薄透材质，文件全局存在alpha<255也不能代替区域通过。阈值是本任务明确选择的审核标准，不能声称由单张原图推得物理透射率；背景、screen不支持此约束，原生PS使用下述独立plan及真实PS输出检查。

普通新v4另可事前显式冻结`kind:"opaque"`实体覆盖下限：仅`name/box/minAlpha`(1–255)/`minPassingFraction`，无`maxAlpha`或`minBackgroundResponse`，实际放置alpha≥minAlpha才计通过。黑色实体、固有印字和墨色仍有覆盖形状，不能把RGB亮度当alpha。此类型无默认，PS/screen/背景/旧流程拒绝，不事后给已有生成请求添加；旧无opaque链不迁移。它只约束实际覆盖率，不证明RGB或物理材质正确。

`prepare`保留冻结原图片box并返回`alphaCheckRegions`，经输出画布及carrier换算为本次生成文件坐标；区域专用映射按起点floor/终点ceil再夹到真实canvas边界，至少采样一个真实像素，不凭min1在画外创造透明样本。prepare与实际诊断使用同一映射，不改变全局图层几何。提示明确原图可见环境孔隙属于背景，不能当遮挡补全，不绘制区域标记。`register`及成功`align/auto-align`用与正式合成相同的完整整数放置RGBA记录`alphaDiagnostics`：原图片/canvas/material区域、alpha分布、像素通过比例及标准黑白底source-over响应（8位RGB差为255-alpha）。通过须满足`passingPixels >= max(1,ceil(pixels*minPassingFraction))`，零通过像素不能靠浮点容差通过。该响应是数学合成诊断，不能等同真实光学透射。

区域诊断v2从一次读取的工作Buffer快照计算摘要，restore/解码/采样使用同一已验证字节；`materialHash`对应此快照的正式物化结果，`workingSnapshotHash`可回读。结束时另校验路径摘要以拒绝持续变更，短暂替换并恢复也不能把另一份字节算成原快照通过。诊断signature绑定原件/工作摘要、来源尺寸、输出canvas、placement、冻结检查及诊断/渲染版本；旧v1诊断/accepted不能继续审核、合成或回传，须重新登记验证，不回写历史终态节点。区域质量失败独立于`isolationProblem`，仍允许按冻结参考点定位；成功定位重算诊断并清除旧层审核及整图审批。文件/放置/约束变更使旧诊断或accepted失效；`review accepted`须区域通过，失败可如实`needs-revision`，数值通过也不证明纹理、材质外观或整图视觉一致。

普通v4辅助matte为可选实验，方法尚须新复杂源图的真实image_gen与视觉验证。仅内部重建协议3、单个非背景normal透明层且有冻结`transmissive`检查时，可在生成前显式设置`layout.layers[].allowAuxMatte:true`；缺字段保持缺失，无默认迁移。PS、旧流程、合并层、不透明背景和screen不支持。先真实`prepare/register` RGB候选并完成必要定位，再`prepare`传`matteForGenerationId`。该请求`role:"aux-matte"`唯一授权有序引用本job精确已登记基底完整`workingPath`与该基底请求的clean local，返回`transparent_background:false`；此局部例外不授权其他未完成候选、预抠图、蒙版或原图裁片拼贴。请求和登记独立冻结task/job/source/layout、基底原件/工作件/工具输出及定位/请求摘要。

辅助`register`只接收当前对话真实image_gen的单张完全不透明8位灰阶PNG原件及原样提示/有序引用。原件保留，超过150万的原件等比生成预算工作副本（原件处理上限4000万）；完整carrier比例差不超过1%，不裁alpha或非等比拉伸。辅助单独存于`auxiliaries`，返回`auxiliaryId`而非正式`generationId`，不能审核、合成或回传成图层。`derive-alpha`显式提供`baseGenerationId`、`matteId`及两份`expected*WorkingHash`，固定算法`min-alpha-direct-gray-v1`：把完整matte工作图统一等比映射至基底完整工作carrier，直接取8位灰值M，`A=min(oldA,M)`，每个RGB通道保持原工作字节值，不增加alpha。拒绝全白、全空、可见材质整体统一灰及无实际alpha下降，不提供opacity、曲线或后调阈值参数。

派生为新的`kind:"derived-alpha"`后台产物，收据`tool:"derived-alpha"`、`toolHistoryVerified:false`及真实双来源ID明确区别于image_gen原件；不能伪造image_gen generationId或覆写原RGB/matte。实际使用的两份Buffer立即摘要、解码与编码使用同一快照，提交前重验源路径、完整登记及当前job CAS；失败保留文件且不覆写新状态。所有审核、合成缓存和回传递归核验双链原件/工作/工具路径、干净来源、冻结计划与规则、定位和receipt。派生align/retarget拒绝，须先定位RGB再重新准备matte，不能默默丢matte接受。来源或定位变化清除未完成派生的旧检查和批准；历史成功节点不回写。数值通过不自动accepted，仍需真实深浅底、RGB纹理、发丝、完整轮廓与最终定位审核。灰matte不能修复RGB污染或错误发束，也不能证明单张扁平图的物理透射率；失败可如实needs-revision，不强制继续直接RGBA重试。

RGB实际生成前的`prepare`请求可选冻结`allowAuxMatte`，缺字段继续缺失、不填默认值。辅助入口要求真实基底请求显式为true且与当前layout一致；RGB输出后、登记前事后开启layout不能给旧请求追溯授权。该字段纳入既有完整请求hash和双链/CAS验证。普通`register`禁止本job已知aux和derived的工具/原件/工作路径、原始摘要及归一预算工作摘要重新标记为image_gen；同字节复制别名也拒绝。审核、合成缓存与正式回传继续拒绝先前误登记的普通别名，包括无区域诊断的记录。此角色守卫不禁止其他真实普通失败候选的needs-revision回传，不重写历史节点，不宣称能证明任意编辑文件的宿主模型历史。

已知辅助/派生raw及working另以完整尺寸和精确解码sRGB RGBA8摘要识别身份：只改PNG元数据或压缩、但逐通道像素与尺寸完全相同的别名也不能普通登记或消费。此身份从真实字节快照建立在进程私有缓存中，缓存键为实际编码SHA；每次来源路径仍须重验对应SHA，异步预检后核对完整registry/job CAS，不信任可后写的像素身份字段。此前普通记录没有新字段也从真实原件/工作件预检，无角色的旧任务保持原路。范围仅精确RGBA和尺寸，不包括相似图、有损改写、重采样或变形，不能据此证明宿主工具历史。

辅助输入编码仅可在`prepare`且有`matteForGenerationId`时可选冻结`matteEncoding`；非aux、register、derive不得覆盖。缺字段及`exact-gray8-v1`严格要求原件8位PNG、每像素R=G=B且alpha255；旧请求不迁移，失败后不能事后切换版本或替换实际生图收据。显式`near-neutral-luma8-v2`允许窄中性RGB：先解码完整未缩小raw为sRGB RGBA8，所有alpha255、全图max(R,G,B)-min(R,G,B)≤16；材质固定为maxRGB>8，整数sumSpread≤2×materialPixels且materialOutliers(spread>8)×1000≤materialPixels（即材质平均spread≤2、至少99.9%材质像素spread≤8）。这些是固定输入编码边界，不能按alpha检查通过率动态调整。

下一次新aux prepare可显式选`near-neutral-luma8-v3`：仅删除v2的全图单点spread≤16上限，完整raw仍必须PNG8/全alpha255、material=maxRGB>8且sumSpread≤2×materialPixels、materialOutliers(spread>8)×1000≤materialPixels。maxSpread仍记录在解析统计，v3常量证明不含全图cap；均值和99.9%尾部限制不动态改。少量有色点可能位于轮廓过渡，允许此编码不代表matte语义/边缘几何通过。缺字段、v1/v2及已失败请求保持原语义，不能补写v3追溯放宽或伪造新实际生成收据。

v2/v3通过原件认证后，固定`M=round((2126R+7152G+722B)/10000)`生成自身不透明灰阶标量PNG，再按完整carrier等比预算缩小；不得先resize抹掉原件彩色异常。actual image_gen原件/tool路径及hash完整保留；working明确为后台fixed-luma scalar，非新image_gen原件。aux `encodingProof`记录编码、固定公式/常量、raw hash/完整尺寸/整数统计、未缩小scalar hash及最终working hash/尺寸；request、binding、aux/receipt和derived proof/receipt全部绑定可选版本。消费者按真实raw/work快照重算认证与确定性归一，私有缓存只按编码版本、实际SHA、尺寸和证明摘要复用，不信后写字段；删除近中性字段也须重新通过旧严格raw认证，v3缓存不能给v2原件认证背书。派生仍`A=min(baseA,M)`、逐通道RGB0变，不修复RGB发束/污染；PS/相似性/原图提取不扩展，方法仍需新的复杂源图实际验证。宿主工具历史仍标false，不能仅凭新声明或文件证明重做过image_gen。

aux `prepare`新增只读minAlpha必要可达性检查：从SHA匹配的真实working Buffer按当前登记整数placement复用正式`restoreGeneration`，使用冻结source→canvas ROI采样。每个transmissive及新显式opaque区域独立计算实际放置alpha≥minAlpha的eligiblePixels；须至少`ceil(N*minPassingFraction)`，否则`min(baseA,M)`无法补回缺失alpha，直接400且不创建request/ref/aux或改registry。alpha255可被降低而计为eligible，少量alpha0按原ROI容差处理，不能遇到一个零值即全部拒；极小正比例仍至少需一个真实采样像素。仅有opaque不扩大aux入口，仍须冻结transmissive检查。不得读取持久化诊断摘要或用户声明来代替新测量。await前后完整registry/job CAS及所有来源/定位绑定重验，输出必要条件报告`matteFeasibility`随新请求冻结；旧aux/derive不追溯增设守卫。通过只说明此下限不阻碍减alpha方向，不预测未来matte、alpha上限/响应、RGB污染、几何或视觉成功，也不自动accepted；普通RGB制作和诚实needs-revision回传仍可用。

新PS v4（内部重建协议3）的透明前景可在`plan.layers[].alphaChecks`冻结原clear/transmissive schema及明确阈值；本次普通opaque类型不适用于PS，schema及持久计划消费均拒绝。不是普通layout，不能改变其他任务或层的范围。缺字段保持缺失，不填默认空数组，旧计划/material/repair哈希兼容；不向旧任务追溯添加规则。区域由冻结来源层的原图片局部像素映射到实际PS画布，沿用floor/ceil/真实边界采样，不能误用已缩放的plan.frame作为来源框。`generation prepare`继承PS计划规则、生成像素区域及唯一carrier提示，登记时检查规则仍匹配；这些生成素材诊断不能代替PS审核。

PS `inspect`从真实逐组全画布透明PNG检查区域，先核验组PNG尺寸等于PS画布，禁止把局部工作图缩放成PS结果。`quality.alphaDiagnostics`版本1包含复用的采样版本2、实际alpha分布、通过像素及标准黑白底数学响应；签名绑定task/job/document、当前干净源与辅助原件摘要、完整计划及来源框/规则、素材原件/工作图/选择版本/定位/提取或repair链、实际PSD及组PNG摘要。缺诊断、旧版本或绑定变化使旧检查、逐层/整图批准与超分证据失效，须实际重新inspect，不回写历史节点。显式区域失败允许记录`needs-revision`并继续修补/定位；本层`accepted`和最终`complete`均硬拒绝失败，不能以全层存在透明像素或红标绕过。完成前再次检查文件及当前状态，异步校验期间的变化不得被旧快照覆盖。

PS `inspect-progress`在未完成全部组时也对已提交ready素材且有冻结区域规则的组导出真实透明PNG和区域诊断；返回`previewOnly:true`，不保存为正式quality、不颁发accepted/complete、不替代全组结构与置入校验。无规则任务保持原进度/审核行为。响应始终是source-over数学底色差，不称真实光学透射、纹理保真或全海报视觉通过。

Layer.frame 为独立的整数图片局部坐标 {x,y,width,height}，可在图片外；x/y/width/height 仍描述预览或最终位图自身的放置，不因编辑 frame 而缩放预览。缺省读取旧预览几何，背景缺省整图。cutoutBox 仅是模型提示，不等于重建画幅。

新提交的预览节点 layer/revise 请求冻结 frame 并携带 frameContractVersion=1；packet.frameContract.version=2 提供逐层生成与回传要求；历史没有 frameContractVersion 的任务保持原处理。返回图层 path 应为实际生图原文件，服务从文件读取 generationSize，校验冻结位置及尺寸，拒绝超过1%相对宽高比偏差、位置错误及缺失图层；不因低分辨率或实际超过请求像素预算拒绝。使用 contain 等比例放大或缩小适配，保留原有 alpha、颜色与细碎元素，不裁透明包围盒。sourceLayerIds 用于明确合并：必须覆盖全部目标来源且不重复，输出 frame 为并集，标注重关联。整图输出尺寸变化时冻结框按坐标比例换算；局部任务不能改整图尺寸。

这些检查验证几何和文件，不证明视觉一致性，也不能证明调用者在提交文件前从未篡改过图像。仍需按 Skill 查看实际生图产物并合成验收。粗抠/精抠预览像素禁止参与重建。

规划层契约：kind=plan、preview=true、disposition=rebuild，必须有 frame，不得有 url/previewUrl/svg/text/psdStyle。只允许存在于 status=preview 的 layers，不得进入 vectorLayers 或正式回传。用户可手动新建规划层并与本地预览混合；保存、标注与任务冻结使用稳定 layerId。确认时所有层（包括无文件的规划层）按 frameContract 参与重建；局部重建后仍有规划层则保持 preview。未完成预览不能导出正式 PSD 或进行矢量化。

## 生成分辨率与实际回传（v2）

- shared/generation-geometry.ts 为 UI 与服务共用算法。generation.size 按 1,500,000 像素预算等比取整，不改 frame。generation 提供 scale、offset、restoreScale、imageToGeneration；annotations 是该层生成坐标，原始 annotations 不修改。合并或总图改尺寸通过 canvas_get_request.generationPlan（groups、width、height）重算。预算是本插件请求策略，不是对上游真实输出能力的声明。
- 回传以实际文件尺寸为准。相对比例偏差 `abs((actualWidth/actualHeight)/(frameWidth/frameHeight)-1)` ≤0.01 时统一等比缩放；整数栅格四舍五入，补边按文件画幅中心分配，不按主体轮廓重新定位。背景补边只允许完全不透明图，复制边缘像素并标明需视觉检查。原生文字/矢量不使用生图像素预算。
- generationSize 记录原始实际宽高；generationSourceUrl 保留导入的原始生成 PNG；generationAdaptation 记录实际 scale、offsetX/Y、contentWidth/Height、aspectError、padding 与 crop。sourceCrop 必须显式给定且只可删除全透明像素，偏移保留；不自动按 alpha 裁边。
- canvas_complete_request(stageOnly:true) 仅用于已有冻结画幅的真实图层。逐层检查并保存 jobs/<jobId>/staged-layers.json，不完成任务、不修改文档或创建节点。packet.stagedLayers 返回 originalPath/adaptedPath 及元数据；取消后不能再提交。最终仍需提交所有目标图层及冻结 baseVersion。暂存及尺寸校验不是视觉验收。

## 逐层视觉检查（2026-09-21）

layer/revise的图层文件可携带review:{status:accepted|needs-revision,attempts:[{method,observation}],issues:[{message,box?}]}。每层最多3次尝试；needs-revision须有至少两种方法记录和剩余问题。issues.box使用最终图片局部像素[x,y,width,height]，省略时标注整个frame。accepted不带未解决问题；服务不能验证描述是否代表真实视觉检查，智能体必须如实记录。文件/画幅/alpha校验与视觉判断独立，不因标红绕过无效文件校验。

原始产物stageOnly暂存携带review；最终回传仍提交选中原始文件及review。服务在新结果节点添加origin=auto-review的红色标注，追加自动意见，设置问题层rebuild、通过层keep；未提供review保持rebuild并提示未检查。自动意见单独记录autoReviewOpinion用于下次通过检查后移除旧报告，不删除用户改写过的文字。

有图层的layer/revise冻结frame；后续整节点revise排除已保留层，目标写入layerIds及executionScope.targetLayerIds，preserveKeptLayers标记自动范围。显式选中图层编辑可覆盖keep选择；来源节点不变。自动范围的整图改尺寸允许统一换算保留层，明确的局部任务仍不能改整图尺寸。完成必须覆盖全部目标图层，保留层不能被回传替换。

packet.localReferences按最终计划逆映射到输入坐标，生成无蒙版的干净裁片，并加入generationInputs.allowedImagePaths。整图仍保留。越界部分透明补范围，不自动裁物体；完全越界或参考尺寸不同不能猜测坐标，返回明确警告。合并或更改输出尺寸需重新领取generationPlan。缓存按来源路径及框生成，仅使用冻结文档素材。

## 独立抠图 cutout

Job.type=cutout，在本地串行队列运行，不进入Codex dispatch/claim/apply。settings.matting={model:birefnet|lucida,options:{birefnet,lucida}}，参数与PSD cutoutOptions完全分开，提交时冻结到job.matting。GET/PUT /api/matting-defaults只修改新画布默认值；当前画布由常规revision保存，老文档缺字段时读取默认值。

python/worker.py matte读取整张输入并调用精细模型；与segment预览分开，即使输入含alpha也不跳过推理。预测alpha经参数处理后乘原alpha，不自动裁边，默认不改RGB。输出必须为本任务cutout.png，PNG含alpha且宽高与节点一致，全透明结果拒收。server/standalone-matting.ts负责准备干净输入并验证文件；取消、节点删除、版本分支使用现有任务保护。结果status=cutout，含一个全画幅正式raster层，parentId/sourceJobId关联原节点；不继承旧预览、矢量文件、图层意见或标注，不自动提交后续任务。

超分引擎字段：`upscale.model`固定为`seedvr2-7b-int8`，旧文档的vosr2或缺省值自动迁移，并删除退役参数。Seed专属字段：seedColor、seedDetail、seedVaeTile、seedVaeOverlap、seedMemory；共用scale/seed。`GET /api/upscale-status?model=seedvr2-7b-int8`检查指定引擎。推荐参数见UPSCALE.md。

## 视频节点
CanvasImage.mediaType=video，source为原视频，url为PNG海报，video含duration/fpsNumerator/fpsDenominator/frameCount/audioStreams/previewUrl，正式结果artifactUrl为MP4。PUT不可改写媒体信息或源URL；视频不得携带图片层/标注。POST /api/document/:id/import-video：单个multipart files，2GB；内部import-path也支持视频。视频仅允许upscale任务，使用同一冻结及来源协议。导出mp4仅正式视频结果；原节点从source下载原文件。新增设置videoFrames=9、videoOverlap=5、videoQuality=18。

新context-only与concise-edit组合的prepare精简重复流程说明，保留全部动态用户意见、标注映射、冻结定位/alpha/遮挡关系、排除项和执行说明。源文字观察若含整图坐标，不得直接当作参考文件坐标；本文件定位采用后台已有冻结映射的百分比，不改变源点或frame。旧prepared提示与默认双参考流程不重写。这是针对r25银字仍扩大/变形的提示歧义修复，改善视觉一致性尚需新的真实候选验证；青光局部通过不能代表字形或整图验收。

新prepare可额外显式设置referenceContext.referenceMode="context-only"，并使用referenceStrategy="local-only"：仅完整周边首图进入模型，不再附旧框局部或全图；不能同时启用detailReferences。未设置此模式时保持旧有序引用及提示。旧局部继续作为只读来源保存localPath/localReferenceHash，用于定位和matte校验，不能作为生成素材；登记、后续使用及异步结束都核对冻结摘要，原样及相同RGBA重编码别名拒收。该模式用于验证双参考构图冲突假设，尚未证明改善真实一致性，不能迁移旧请求或移动源定位点。

## Reconstruction v3

新任务的增量流程标记reconstructionWorkflowVersion=4，见[重建v4](RECONSTRUCTION_V4.md)。下面v2/v3中的旧流程要求只用于历史任务；当前实际执行以插件RECONSTRUCTION.md为准。

新framed layer/revise及所有PS任务设置Job.reconstructionVersion=3。新增canvas_generation，对应POST /api/jobs/:id/generation，使用相同taskId与bridge鉴权；变更要求running。prepare/register/align/review/status详见[协议](RECONSTRUCTION_V3.md)。原件、工作图、对比图摘要和元素验收保存在任务generation/registry.json。普通完成必须匹配登记ID、原件摘要和冻结frame；旧任务仍兼容，若主动传generationId则同样验证并应用定位。PS生成素材绑定单层plan摘要。place-material使用完整文件智能对象，inspect与complete验证嵌入文件及四角。文本样式由PS原生回读补充PSD解析。

## 新任务的显式背景保护派生

派生本件须在自身当前comparisonHash上另做接缝review accepted，覆盖全部元素、geometry/appearance/isolation及本件候选ID，然后才能进入普通composite/apply或PS material/place/inspect等消费。父件accepted和keep/fill逐像素零差不替代这一步：源选区边缘可能把两幅各自连续的字笔/图标拼成台阶。未审核或needs-revision拒绝消费，保持失败审核；直接review与status仍可用，身份/来源/文件守卫仍执行。PS外部执行返回后及同步提交前再次检查当前本件审核；等待期间被改为失败的迟到结果不得登记置入选择或检查通过，生成的诊断文件保留。本件对比文件变化使审核与缓存合成失效。旧无sourceProtection的普通/PS素材流程不变。

普通v4 `layout.layers[].sourceProtection` 与PS v4 `plan.layers[].sourceProtection` 可在首次prepare之前冻结 `{version:1,sourceHash,keepMask:{path,hash},review:{path,hash}}`。仅一个单层normal满幅opaque背景；PS还必须 `allowExtraction=true`、generate/hybrid。来源须为当前冻结节点的干净、无嵌入ICC的PNG8工作图，尺寸等于完整canvas且不超过150万像素，不在此核心隐式缩放或转色。上游规范化须另有真实来源记录，不能宣称工作图零差异就是原编码文件零差异。

选区和review存于本job的 `background-selections`，不能复用预抠或其他任务文件。选区是独立制作的满幅不透明二值灰PNG，255只保留确认可见背景，0覆盖全部前景、浮字、独立光、混有半透明前景的像素及未知遮挡区，必须同时含0/255。review JSON须绑定taskId/documentId/imageId/jobId/sourceHash/keepMaskHash，status=accepted与具体observation；这些声明和摘要不会自动证明蒙版语义，执行者必须先独立看源图与选区。保护选区不传给image_gen冒充硬约束。

真实生成补全仍prepare/register保留完整工具原件；派生前须对真实父件完成当前comparisonHash对应的accepted review，逐项检查prepare全部元素、固定结构位置、保护边界附近连续性及排除项，并分别记录geometry/appearance/isolation与真实候选ID。未审核或needs-revision的父件拒绝派生，不能靠贴回源选区掩盖变形。父件审核、对比文件变化使派生或消费失败。随后 `derive-background {baseGenerationId,expectedBaseWorkingHash}` 生成 `kind/receipt.tool=derived-background` 新登记：keep255原位置保留工作源RGBA，keep0使用真实生成背景工作RGBA。父登记、当前来源、选区、独审、完整计划和请求均绑定；固定字节快照计算后重新验证，变动不提交旧派生，不覆盖并发登记。不能align派生背景；保护计划的合成须选择派生结果。路径/摘要/精确RGBA重编码别名不能重新获得image_gen身份。旧无此字段任务不迁移，也不能对已prepare任务追开或追改计划。

PS material须 `provenance=source-protected`、自身派生generationId及 `evidence.backgroundProtection:{tool:'derived-background',generationId,baseGenerationId,sourceHash,keepMaskHash}`，不填写generation/extraction冒充原件。保留满幅工作文件，拒绝强制超分改写保护像素。全部消费、缓存、PS提交及complete重验来源；来源改变使旧审核失效。source-protected背景必须同尺寸满幅1:1置入，禁用普通背景的防空边放大；置入与最终核验均逐一检查完整文件四角，容差0.0001像素，拒绝平移、缩放及错位。普通opaque背景继续原防空边策略。文件空间零差异和四角正确仍不能推断PS渲染颜色及实际像素零差异，须另查实际PS导出。选区语义、孔洞补全、接缝及完整普通/实际PS合成必须真实审核后才可接受；机制测试不代表视觉验收。

v4新prepare的外观保留要求仅保护本层固有外观；明确排除或另层归属的对象及其固有效果，即使源参考原有也须移除。不能因某处发光就删除本层固定灯、窗口灯或反射；归属不明保留观察待审，用户明确意见优先。普通structured背景结尾按连续不透明背景处理，不再附加前景真透明指令。旧prepared请求和v3提示不重写。这是针对真实复杂海报背景误留另列笼灯的指令冲突修复，模型因果及真实改善仍须新候选验证，测试通过不等于视觉通过。

背景对同类光源反复误归属时，先用现有detailReferences指认来源，不默认新增接口或重试相同提示。完整未标记首图决定构图；细节从干净完整源在冻结位置原样裁取，明确每处是识别移除的另列对象还是识别保留的本层固定灯。每处observation写清归属、不可粘贴裁片，最多3处、合计262144像素，不能预抠、绘制诊断标记或作为正式素材。旧请求、源图、frame、定位点和计划不改，先核对源RGBA/完整引用及消费者拒绝参考素材，再做一个有依据的新候选。真实输出仍失败则红标，不再以相同方法盲目重试；继续其他组须有明确验证收益，此方法尚未证明能改善模型分离。

插件改进实验每轮必须是针对前轮真实失败的全新复杂海报，具备密集文字、角色、独立光效、材质与遮挡。双路真实输出及必要组合检查已充分证实失败时，可将本轮结束为失败，明确记录未生成层、未完成合成、未进行独审并保留原图/冻结身份/全部候选和文件；之后有依据地修正插件或循环规则，再用新图验证，不为凑齐失败轮层数继续生图。缺乏修复或新测试设计不得反复换图。该退出只适用插件验证实验，不擅自终止用户完整重建任务。成功标准仍是完整普通与原生PS重建文件、全部语义层/文字/遮挡/独立光效、整图实际对照、回传可见和独立整体验收，局部与技术通过均不替代。执行复用现有实验驱动与生产接口，避免逐层复制执行程序。

v4首次prepare的通用外观说明不再对全部材质列举亮边、反射、柔光和有光泽文字，改为按参考保持本层材质、颜色、明暗、纹理和形变，既不新增亮度/光泽，也不抹除源中已有光泽。用户明确修改继续优先，排除项和透见后景归属规则保留；v3及已经冻结的prepared提示不追改。依据是两路线真实复杂印字暗橙布旗均变亮、变得更有光泽。提示偏向只是待验证原因，不能宣称删改文字已修复模型材质；不对素材像素做自动改色或源RGB补贴。

候选30曾试验精简concise-edit通用归属说明、增加“表面印字不按转录内容重新排字”。r27全新复杂源的双路蓝牌真实生成仍出现整牌在文件内缩小/移位、内部字形/字距/鱼图/阶梯及留白改变；真实PS工作嵌入和四角正确。该试验未解决此样本，也不是与不同旧源的严格因果A/B。候选30原件、提示、源码归档、失败审查和测试日志全部保留；当前源码撤回这两项未验证有效的提示改动，恢复候选29的后台行为。旧prepared与实际候选30运行实例不重写，不把撤回当作视觉修复或整体验收。

几何一致性修复实验先明确采用自动测量还是人工对应点，不再把每轮人工源点独审设为所有插件修复与自动定位实验的前置阻塞。自动定位沿用当前冻结干净源参考和真实生成原件，source/reference哈希仍受守卫；SIFT/ORB互相唯一对应在RANSAC之前按源点x/y排序，每四点保留一处检验点，不用于模型选择、拟合或消费者再次拟合。训练集保持原空间覆盖、12个内点与0.40比例下限；检验集至少4个点、0.60比例、两轴0.20空间覆盖，误差仍为max(2像素,短边0.003)。后台根据实际对应点重算检验，拒绝后不写新working文件、不移动素材；有内部特征证据但失败时禁止改用alpha外轮廓兜底。特征不足时保留原有严格轮廓测量；轮廓通过只证明边缘定位，不证明内部字形。仅统一等比缩放和平移，不居中alpha边界、不拉伸、不粘源RGB。人工定位仍要求首次prepare前冻结准确命名源点；作者自查须与独立审查分开，缺少可靠点则不用人工align，不追改旧计划/请求。自动检验点不是独立视觉审查：字形、图标、透明、光效与完整普通/原生PS结果仍须真实对照和最终独立验收。旧候选、失败审核和未生成层保留；每个下一实验轮仍用针对前轮失败的新复杂海报。没有新实现或明确诊断收益不盲目换图；前置审查暂不可执行时推进有依据的研究/代码修复，不把整体目标标为完成。

JSON状态文件仍先创建同目录唯一临时文件，再用rename替换；临时文件使用wx，不能覆盖已有文件。Windows遇到EPERM/EBUSY时最多增加4次替换尝试，间隔10/20/40/80毫秒（总等待不超过150毫秒）。只有目标文件和该临时文件的内容摘要/文件身份/修改时间仍与首次替换前一致时才重试；观察到任一变化、无法读回、其他错误或耗尽次数就抛错，保留临时文件和现有目标，禁止先删目标或用直接写入兜底。这是短暂共享锁的恢复措施，不是跨进程文件锁或文件系统CAS；检查与rename间仍不能约束外部写入。原有任务/registry来源与版本校验继续执行，重试不得重新推理、生图、登记或提交业务请求。依据是r27代码检查在三个不同测试的JSON替换上发生Windows EPERM，串行执行仍出现；视觉一致性和整体验收与此文件保存修复无关。

新v4 prepare可显式设置`referenceScale:2|3|4`试验完整参考呈现：仅单层normal透明前景、local-only、无周边/细节参考。窄条局部允许既有透明承载扩展，后台将整个承载文件（含全部透明边距）以Lanczos3等比放大为唯一模型参考；无承载扩展时仍用完整干净局部；放大文件含全部留白也不得超过150万像素，超预算明确拒绝，不裁边或静默降倍率。冻结设计frame、源定位点、输出预算与旧请求不变，原局部仍保留为只读定位/来源依据，模型引用仅替换为声明的全幅呈现件。插值不会新增真实源细节，改善密集印字保真只是待实测假设。两件均绑定摘要，原样及精确RGBA重编码不能冒充生成素材，任何定位/审核/回传仍需核对原件和原局部。新实验轮须用针对旧失败的全新复杂源，不把呈现件用于生产像素补贴、预抠或通过验收。

新v4透明前景prepare的薄透自身/后景归属说明不再以是否声明transmissive数值alpha检查区为前提。若含薄透材质，保留自身印字、水滴、刻痕、反射，排除已明确归入后层的结构与颜色；已可见轮廓、曲率、端部与原位截断不得借隔离/补全改变，未受分离影响的实体覆盖率保留。此修改仅调整新请求提示，数值检查仍须事前显式声明；不新增默认alpha阈值、辅助matte授权、几何点或素材处理，不追改旧prepared。依据R29实际双路面罩曲线/端部变化且真实PS放置正确；删除错误前提并不证明模型几何或材质已修复，新复杂源及最终双路完整输出仍需真实验收。

复杂遮挡人物可按头脸/发丝、衣身/围巾、可见手/手套作有依据的分件试验，但不将分件或扩大周边视为默认保真修复。R31双路头部分件和R32双路周边单参考都仍改变原位头部大小位置；真实PS完整素材嵌入/四角正确，自动定位证据拒绝。撤回C37新增的设计框百分比/透明占位提示和强制头部周边策略，恢复此前已验证的后台准备行为；周边参考原有入口保留，只在可见边界/语境有具体需要时显式规划，不自动扩大、叠加提示或放宽定位门槛。C36分件仅作为缩小问题范围的试验方法，不把它的成功隔离当头部保真。新计划的frame、唯一elements、排除项和头颈—衣领/罩—眼鼻/手—持物关系仍须源位冻结，不传预抠像素、源RGB裁片或诊断图作为正式素材。已有失败先依据保留真实原件及原source/local哈希，查看实际对应点分布、未参与拟合的检验点与局部图像，区分错误对应、非均匀重绘和整件比例变化；诊断不改源点/画幅，不把拟合失败换成轮廓或阈值兜底。每个新模型实验前必须有这类证据支持的机制变化或明确新的验证收益；不以增加描述后重复同一方法继续生图。下一真实实验仍换针对已解释失败的新复杂海报，同轮源不变。修某一件保留已确认其他件，头部关系未过不为填层数制作衣手；正式完整普通/原生PS输出与独立验收均不可被阶段诊断、代码检查或组件自审代替，旧任务/素材/失败不追改。


自动特征定位失败时，用 scripts/review-registration-points.mjs 查看真实对应点，先解释失败再决定下一项修复。输入清单包含真实 taskId 及 freeze、prepare、registered、alignment 四份回执的 {path,sha256}；freeze 必须含同任务 jobId/imageId、当前干净 sourcePath/sourceHash 及来源层 ids。脚本核对真实登记原件、prepare 的干净局部、冻结源像素及原测量 evidencePath，仅支持可直接映射到当前源像素的框；不能猜测改尺寸映射。各按原生成点 x/y 顺序固定均匀选最多三个拟合点和三个已有检验点，不按残差或通过状态挑选，不重新拟合或补点。输出新的 ≤128KiB JPEG 与摘要回读，默认检查只读上下文预算，不覆盖旧文件。此图用于辨认背景误匹配、局部重绘和整件比例变化；它不自动确认对应语义、不修改素材或阈值、不进入生图参考、不代替独立审查。没有可靠特征或仅轮廓提案时明确拒绝，不能生成假对应图。R31/R32 五官检测离线试验对分辨率/透明底敏感，未接管正式对齐；检测置信度不等于像素测量精度。


完整场景首参考实验（C42，R34后停用自动续作）：R33仅有有限几何支持且保留其他层面罩；R34采用C43并明确列出DB09面罩排除项后，两次真实头部输出移除了面罩，但仍放大移位，自动定位均拒绝。仅缩小参考特征搜索范围的只读诊断C44仍双路拒绝。因此不把完整源+完整头部carrier作为稳定定位方案，不自动在下一张图重复这一方法；需要新的具体机制及事前冻结的检验设计才能重新测试。完整源始终不能登记成分层素材，预抠只规划，原件与旧失败保留，不放宽12个拟合内点/4个留出点等既有门槛。C43材质作用域修复保留，但本轮是新源、明确排除项与代码组合观察，不宣称孤立的代码因果或完整两路线通过。


透明画布与薄透物体分开处理（C43）：新v4 normal前景的透明输出只定义物体外alpha，不默认把本层实体解释为玻璃或膜。仅冻结transmissive数值区域时，提示才肯定说明本层薄透区域及实框/铰链；没有这类区域时，材质后景RGB分离规则保留为仅针对本层实际薄透区域的条件说明，并明确不得带入已排除的透光附件。固有印字、轮廓、实体覆盖率仍保留，不按明暗做透明掏空，也不自动添光晕。此改动删去普通实体的默认硬件保留要求；不改变API、冻结归属/ROI/参考和旧prepared，不修改旧图，不保证模型隔离成功。R33完整源首参考的两路仅自动等比定位有限通过，仍带面罩及多余晕而needs-revision；独立头层与薄透层在下一张新复杂图的真实完整输出中仍需验证。


透明图可见性审核（C45）：工具直接显示的PNG颜色不单独证明跨层光晕、背景残留或不透明覆盖。先核对真实alpha，并将同一原件按Normal正确合成在深浅底；PS路线再看真实PS隔离组渲染。alpha为0的RGB不作为可见内容问题，软alpha发丝/反射与额外光效须根据真实合成逐项区分。发现工具显示与正确合成不一致时，修正本轮判断，不修改原件来迎合预览，也不为未证实的问题启动生图。R34工具预览棕底看似光晕，而深浅底/真实PS未证明同样宽晕，本轮正式失败以已证实的头部比例位置和外观为依据。

## 重复审查意见的错误分类（C49）

v4逐元素审查若使用相同观察模板，接口返回400并保留原素材、已有审查和任务状态，修改为各元素真实观察后可继续提交。不得将这个输入问题当作内部故障、生成失败或要求额外生图；不放宽拒绝重复模板的条件。此修复来自R35真实审查请求返回500的回执，不改变视觉验收标准。

## 复合透明组的归属（C48）

新v4 normal前景若包含薄透件与其背后的同组实体，保留元素清单内实体承接的可见RGB；悬空薄透窗口只保留材质自身外观，以局部alpha透见组外后景。不得因同组存在实体而让该窗口近不透明，也不得为去后景挖空同组脸部。此为新prepare提示修正，不是自动蒙版、像素去背景或默认透明阈值；旧请求、源、定位和独立光效保持冻结。真实R35两路整体人物几何已有广域对应，但面罩悬空窗近不透明，父件均needs-revision，没有创建子层。C48仍须新复杂源验证，不能宣布整体验收。



## 区域材质语义分离（C50）

新prepare只把clear环境孔隙解释为可清空；transmissive要求连续非空薄透材质，主要像素满足本项已冻结minAlpha、maxAlpha及minPassingFraction，移除组外栏杆/格线后景RGB，不用近乎空白或零散细边替代材质。opaque保留实体下限。三个类别不混用，不改旧请求、检查区域、数值阈值、几何或素材。

依据R36新复杂海报真实失败：自由窗已随底色变化，但普通72/140、PS119/140像素符合生成前冻结24..224（要求126）；普通同组脸领覆盖通过，实际PS深浅底响应162.781。此修正为提示假设，未证明完整视觉通过；R36失败及原件保留，下一轮须新复杂源和真实PS对照，不能放宽旧标准或导入失败父件。


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

共同定位点是可执行的参考约束，不是像素一致性证据。PS原生薄膜还须按当前源观察其实际边界、冻结独立路径/渐变并真实渲染，与自身框/印字/细节组合检验；普通仍用自身当前对话真实生成。组件失败可结束有充分双路实际证据的实验轮，保留未做层及未完成整图/独审记录，再修复并使用新复杂源；普通用户完整任务与两路整体验收目标不因此结束。代码测试不等于实际图像验证。

# C69 原生PS平面字形接口

`nativeTextPlane` 显式冻结v2实际字体配方，同序PS文字目标。`render-native-plane-text` 仅本job空组新副本、72dpi、150万工作像素内；真实字体文件/Unicode覆盖/PostScript名验证后，由实际Adobe执行缩放、斜切、旋转并保存可编辑层。输入摘要与任务状态竞争拒绝提交，文件保留。计划/输入/实际输出/字体未变才能复用制作回执；进度及最终交付重新验证实际原生字形元数据。不得以收据、模拟测试、局部通过替代alpha/源外观/两路线整图独立验收。

# 新v4独立模型分件引用

独立透明前景和screen光效已有干净局部时，prepare省略referenceStrategy默认只提供冻结局部承载画幅及必要细节。完整海报只在显式local-and-global时补充；背景、旧流程、辅助matte/双板及原生配方保留原引用方式。返回的referenceStrategy、prompt和有序referencePaths一起冻结，登记须逐项匹配；不改旧请求，不把局部参考当作输出像素。参考范围改变不保证位置、字形、姿势或光学归属一致，必须通过实际输出核对。

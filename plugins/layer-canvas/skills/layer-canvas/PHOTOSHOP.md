# PS 重建执行手册

简单定位符若实际生成产生高度/倾斜失真，新v4可在首次prepare前使用`nativeGeometry`改走真实PS实色四边形形状；不是反复生图或事后拉伸。仅native/shape/native-shape的独立v2实体件，冻结人工观察的四角、RGB和唯一归属，1–8个凸四边形、各最多一个内含四边形透明孔。不得用文字、复杂纹理、薄膜、光效或源像素mask冒充此配方。调用`render-native-geometry`只写本job空目标组的新副本，返回未验收制作收据；仍须inspect-progress/inspect实测孔、alpha和PS实际输出，逐层及整图对照。具体配方与边界见docs/PHOTOSHOP_REBUILD.md，普通路线仍使用自身实际生成和配准证据。

新v4生成的独立v2透明实体分件可在PS plan首次prepare前冻结`contourSearch:{version:1,box:[x,y,width,height],observation}`，使用最终画布像素且须完整属于本层frame；规则与普通路线一致，仅限定配准测量目标，完整参考及素材不裁切。不能用于原生文字、薄膜、背景或光效，不能在auto-align/prepare时追改或覆盖；独立PS实际素材及原生渲染仍需自己的证据与最终验收。范围内重复目标或不相容形状仍拒绝，不放宽原配准门槛。

新v4 `inspect-progress`也检查本任务PSD已有的可见原生文字/路径组，导出其透明、深浅底、文字报告和已冻结区域alpha；空组、隐藏文字或像素占位不能算原生ready。此进度不写materials、不改变验收状态，不能冒称最终inspect或完整PSD通过。整体仍须完整内容、真实渲染与逐层/整图复审。

当前新任务为v4，先读同目录RECONSTRUCTION.md的Photoshop段落及公共几何规则。历史任务按packet版本兼容。

顺序：plan → 当前对话生成/登记 → material工作图 → place-material/原生制作 → inspect-progress逐层合成检查 → inspect/review → 需要时upscale-material → 重新置入检查 → review-composite → complete。

frame不变；carrier是生成文件承载范围，placementFrame是素材实际位置和大小，允许保留框外像素。PS完整文件四角按实际放置核验，不以alpha包围盒居中。每次继续编辑返回的新PSD；保护用户其他文档。

元素唯一归属，背景排除独立前景和光效。位图默认生成；文字和路径根据实际参考选择能保持一致性的方法，原生文字须能匹配源字形，不能因为字行看起来简单就默认套用某个字体。字体、颜色、字距、旋转、斜切、warp与样式必须对照真实参考，不默认直立雅黑，也不做明知不匹配的可编辑替身。

新复杂插件改进轮在冻结原生文字计划前，必须查看同源原尺寸字行，独立读回源墨迹范围、粗细与内部字距。`textTargets.box` 是实际源墨迹框，不得默认复制带留白的 `frame` 或 carrier；阈值像素边界仅供观察，不自动证明语义或字体。无法确认的源字形明确受限，不以猜测整框代替。`fit-text` 向该已确认墨迹框拟合，辅助几何与常见效果；bounds吻合不代表笔画、内部字距、颜色与实际渲染吻合。旧目标和失败试排保持，事后观察不能追改冻结记录；字体/字距另试副本明确标为诊断，不声称匹配原冻结参数。正常旧任务仍按已冻结目标执行。

字体尚未确认时，原生试排属于制作诊断，不属于已确认的字体匹配。先读取实际安装字体，按同源字行的单字宽度、笔画和字符位置选择有限候选；新诊断一次最多比较三个有依据的字体，不预设所有字行的统一字体或字距。不匹配时保留具体限制和真实失败文件，依据已有尝试评估独立像素层；简单无衬线字行也适用，不能靠再拟合整框洗掉内部差异。改变已冻结字体或路线须提交另存的新计划修订，明确同一task/job/layer、原计划摘要及改变原因；旧计划、源点和试排证据保留，不伪称参数改变匹配旧计划。未解决字行标为需修订，可继续其他独立层和可验证关系，不因一个失败字体暂停整个改进循环。

## 高保真执行检查

- PS 的可选提取路线允许从干净原图真正隔离可见物体，再用实际生成素材或 PS 合适的填充方法补全遮挡。不得读取预分层粗抠/精抠预览像素作为正式素材，也不得用矩形原图裁片拼贴。可见背景保护只保留确认属于背景的像素，全部前景必须挖空，缺失区域由干净生成背景补全。
- 文字、发丝与半透明边缘不能仅硬阈值后二值化。检查真实透明度、前景颜色污染及深浅底实际显示；需要时从原图估计软alpha并验证。提取的艺术字必须标明是像素内容，不能声称可编辑文字或矢量。
- 光效看最终合成：星心、细线、宽柔散射、色调和衰减均要对照原图，确认实际可见且没有重复叠加。检查混合方式、蒙版和层顺序；工具调用成功或有一层叫“光晕”不证明效果保留。拟合光贡献是按原图测量和合成复核，不凭文字描述硬画一条亮线替代柔雾。
- 前景桌面、玻璃和遮挡人物下沿的物体不能混入最底背景。规划时单独列层并记录遮挡顺序；旧冻结任务若通过对应 PS 逻辑组内的命名子层修复，应明确映射与边界，不私改冻结ID，不把这次补救当作正确的新规划。
- 查看最后真实 PSD 渲染再逐层审核。发表审查候选使用不可变序号或唯一原生文件路径、SHA256及对应逐层预览；评审期间禁止覆盖同名候选。独立审查发现遗漏或明显漂移，不得仍报全部matched。

上述是执行策略，要求 Codex 实际选择方法、运行并审查；不代表插件已内置通用的自动提取、字体识别或光效拟合算法。一次海报的掩膜坐标、脚本、字体和参数不得套用到其他图片。

超分在原素材PS合成确认后执行，超分版重新置入检查；不先放大明显漂移的候选。损伤细节时选未超分工作版等比放大，原始返回仍保留。

工具列表和参数匹配不证明视觉正确。查看真实图片并逐元素检查，已确认的问题可在一次真实检查后红标并说明，不强制追加制作；尝试次数是上限。本次插件改进测试每轮换新复杂图针对前轮失败，正常PSD任务仍使用冻结原图。字段缓存缺失用项目CLI转发同一任务，不创建其他对话或独立API推理。

## 局部透明素材修复

旧的半透明污染不能靠在上面再叠一张透明补片消除。已有 `material` 可选传入 `repair: {maskPath, expectedBaseWorkingHash, baseArtifactPath}`：`path` 和 `generationId` 仍指本任务真实登记的 image_gen 补丁；同层须已有 ready 的完整工作素材，`baseArtifactPath` 须是当前任务内实际置入该素材的 PSD，`expectedBaseWorkingHash` 是此工作素材 SHA256。

重建v4（内部协议v3）的 `hybrid + transparent` 层在 `allowExtraction: true` 时也可先提交真实PS提取基底：`provenance: "extracted"`，不传 `generationId`，原件必须在当前job目录；`evidence.extraction` 说明真实选区/软alpha方法和遮挡区域，额外填写 `sourcePath` 为packet中的当前干净输入。不能引用预抠预览、其他job文件或普通路线失败合成。`placementFrame` 可明确完整文件carrier的文档放置框；未传时使用计划frame，后台按完整文件等比contain，不以alpha边框定位、不分别拉伸。全源carrier可保留透明外沿；超过150万像素的原件保存并等比派生预算工作图。提取receipt及原件、工作图、干净输入、辅助原图、位置、task/job/layer/plan的绑定均保留；receipt是可审计声明，不能当作宿主签名的PS历史证明。

随后仍在同层prepare、实际image_gen、register补片，再以 `provenance: "generated"` 和真实 `generationId` 请求repair。派生链明确区分extracted/generated基底；提取来源也会在place、预览、inspect、review、upscale和complete重新校验。修改来源文件、位置或计划使旧检查失效；推导期间改动会拒绝并保留派生输出。此例外不开放opaque/screen背景、不改变纯generate/extract/preserve路线，也不需要将提取文件登记成image_gen。

`maskPath` 是任务目录内、与完整基底工作 carrier 等宽高的独立蒙版。白色不透明权重为1，黑色或透明权重为0，灰色为过渡；蒙版必须明确覆盖本次确认的污染区，不能沿用另一张图片的范围。后台按实际智能对象完整四角与登记的补丁位置统一映射，以预乘 alpha 插值替换 RGBA；白色核心可将旧 alpha 降至补丁 alpha，权重0处四通道原样保留。基底和补丁工作图均不得超过150万像素，不裁透明边，不按 alpha 框重居中。旋转、透视、非矩形四角、素材自带 ICC，以及 LC_MATERIAL 的额外蒙版、混合或自带效果目前会明确拒绝，避免猜测位置或静默改色、删效果。

派生文件使用新的完整 carrier，保留原基底、补丁与蒙版并记录文件哈希、登记来源和位置。继续走已有 `place-material` 替换唯一 `LC_MATERIAL`，然后 `inspect` 深浅底与整图。基底、补丁、蒙版、派生文件或来源定位改变会使旧检查失效；派生图不能冒称新的 image_gen 原件。该路径不创建新的 repair 叠加层。历史手工补片应先在新副本中按确证来源移除；未知效果不按名称猜测删除。范围保护与来源校验通过仍不代表纹理、发束连续性和接缝已视觉通过。

推导完成提交前再次比较开始时的完整ready基底绑定，并复核补丁登记来源与位置。另一个请求已更换基底或完成对齐时，旧修复会明确拒绝提交、保留派生文件，不能以旧expectedBaseWorkingHash覆盖新的ready状态。

实际使用的PSD、基底、补丁和蒙版字节立即绑定快照哈希；解析、计算与副本共用该快照，不以稍后路径的新摘要替旧计算背书。inspect在全部渲染与比较完成后再次核对整个materials和plan，期间新ready或定位变更会拒绝旧检查，保留渲染文件。

## 控制视觉检查的对话体积

PS 导出的全画幅 PNG 可能每张数 MB；反复直接 `view_image` 会把图片留在模型历史中，token 未满仍可能发生传输或 `Bad Request`。检查总览前先运行 `node scripts/review-image.mjs <原始图片> <新的检查图.jpg>`，再用 `view_image` 的 `detail: "original"` 查看这个检查图。默认长边不超过 1536、文件不超过 384 KiB；每次只看当前决策所需图片，避免把所有深浅底预览一并载入。

此 JPEG 仅供查看，不能用作生产素材、透明度证明或精确像素差依据。原 PNG/PSD 不改动；需要弱光尾、透明边缘或字形细节时，通过第三个 JSON 参数 `crop: {left, top, width, height}` 生成原坐标局部检查图，可指定 `background: "#202020"`。透明度和尺寸数值仍测量原件。不要把图片 base64 打印为文本；不要把 token 计数或短暂恢复当作 HTTP 400 已修复。

Codex 启动上述脚本时，会依据真实 `CODEX_THREAD_ID` 只读检查当前活动历史，按16MiB工作预算预留4MiB系统/工具空间和本张预览的base64空间；超预算拒绝继续添加查看图。独立检查可用 `node scripts/check-context-budget.mjs <当前历史.jsonl> 8`，其中8表示为下一次生图预留8MiB；这是保守工作预算，不能声称是服务端硬上限或所有400的根因。每阶段保存PSD、原件路径、哈希、通过/未通过项，减少重复回传。预算不足应使用宿主真正执行的官方上下文管理；发送文字`/compact`不证明执行了压缩。禁止压缩、清洗或截断已索引的会话文件，禁止修改私有索引数据库。

背景保护须使用新任务首次prepare前冻结的sourceProtection与独立选区审核，allowExtraction=true。真实image_gen补全登记后derive-background；material明确source-protected和backgroundProtection凭证，不能generated冒称工具原件。不得强制超分或重新定位保护像素。source-protected满幅背景同尺寸1:1置入，不启用普通背景的防空边放大；置入及最终核验四角须在0.0001像素内。完整文件/源链和四角核验不等于实际PS导出像素、接缝与整图一致，须实际检查渲染；参数见docs/CONTRACT.md。


## 光学组件唯一归属（C62，显式新计划）

R42真实双板失败，连续薄膜保留组外钢梁且黑白响应近零；C61只修复完整载体缩放，不能修复生成内容。下一次新复杂源实验改为将薄膜本体、实体印字/边框、可选水滴/划痕等表面细节分别建计划层；独立光效继续独立。普通layout及PS plan可显式填写opticalPart:{version:1,assemblyId,kind}，kind为thin-film、opaque-structure或surface-detail。每组件恰好一个薄膜件、至少一个实体件，可有多个细节/实体件；每件一个真实来源层，元素不能重复，冻结alignment/occlusion关系须连通全部成员。

仅新v4正常透明前景。每件须有本件之外clear区域；薄膜须有transmissive，不能带occupied/opaque印字规则；实体须有occupied（普通可opaque），不能带transmissive。数值继续显式冻结，不默认调整。背景、独立光效、nativeText普通实验、sourceProtection、aux-matte及packedBackdrop不能充当光学分件。PS分件只允许generate或真正可编辑native，extract/hybrid/preserve不接受本实验声明；原生路线仍受原生内容/编辑能力的既有校验，计划不是真实执行。

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
# C69 显式平面原生文字

PS印字层可冻结 `nativeTextPlane:{version:1,recipe:<nativeText v2>}`，同序 `textTargets` 需匹配真实字体PostScript名、文字、颜色、平面角度和事前墨迹框（与局部框映射四角至多3px差异）。透明native/text/native-text；光学分件仅v2 opaque-structure，薄膜/光效不能套用。

`canvas_ps_rebuild input:{action:"render-native-plane-text",layerId,inputPsdPath}` 只使用本job空目标组、72dpi、完整画布<=150万像素，在新副本按冻结仿射的缩放/斜切/旋转制作真实可编辑文字。字体缺失/摘要变化、位置或实际PS字体/变换回读不符时拒绝，不从源取RGB，也不通过fit-text拉伸补救。首次prepare/制作后冻结完整计划，完整收据未变才能复用，不重复添加文字。原输入与已打开文档保留。

实际制作不是acceptance：继续inspect-progress/inspect的真实alpha与深浅底、源对照和全图独立审核；隐藏字、像素替身、样式修改、未制作空组不算完成。旧计划与fit-text默认行为保留。

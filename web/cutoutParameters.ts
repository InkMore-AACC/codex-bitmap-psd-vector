export const help: Record<string, string> = {
  resolution:
    '模型内部处理尺寸，不改变导出图片尺寸。增大可保留更多细节，但耗时与显存明显增加；减小更快，但细线可能丢失。BiRefNet 推荐 2048，Lucida v7 按 1024 训练；更大不保证更好。必须为 32 的倍数。',
  padding:
    '在 Codex 给出的物体框外增加原图上下文，单位：原图像素。增大可避免截断发丝、光晕，但可能带入邻近物体；减小更聚焦，过小可能裁掉效果。不会先用粗蒙版擦除像素。',
  feather:
    '轻微模糊透明度边缘，单位：原图像素。增大让边缘更柔和，但会模糊发丝和细节；减小更锐利。0 保留模型软透明度，建议先用 0。',
  offset:
    '沿边缘扩张或收缩透明度蒙版，单位：原图像素。正数扩张保留范围，可能带入背景；负数收缩去杂边，可能损失发丝和光晕。0 保留模型结果。',
  blackPoint:
    '透明点：低于此透明度的像素变为完全透明。增大能清除灰雾，但可能删除微弱光晕和烟雾；减小保留更多半透明细节，也可能留下背景。默认 0。',
  whitePoint:
    '不透明点：高于此透明度的像素变为完全不透明。减小可让发虚的实物更实，但可能破坏玻璃透明感；增大保留更多透明过渡。必须大于透明点，默认 1。',
  threads:
    'U2NetP 使用的 CPU 线程上限。增大可能加速，也会占用更多 CPU，过多不一定更快；减小更省资源但可能变慢。模型输入固定为 320×320，不提供无效的分辨率设置。',
  device:
    '自动：优先使用可用的 NVIDIA CUDA 显卡，否则使用 CPU。显卡通常更快；CPU 更通用但高分辨率较慢。指定 CUDA 而不可用时明确报错，不偷偷换模型。',
  precision:
    'FP32 全精度：兼容性与稳定性优先。FP16 半精度：CUDA 上通常更快、更省显存，但细微透明度可能有数值差异；CPU 使用 FP32。不是抠图质量等级。',
  decontaminate:
    '去除边缘残留的原背景颜色，改变前景 RGB，不改变透明度。开启适合换背景的发丝；关闭更保留原始色彩，适合彩色光晕、玻璃和特效。通用默认关闭，可按图片开启。',
};
export const labels: Record<string, string> = {
  resolution: '处理分辨率',
  padding: '框外保留范围（px）',
  feather: '边缘柔化（px）',
  offset: '边缘扩缩（px）',
  blackPoint: '透明点（0–1）',
  whitePoint: '不透明点（0–1）',
  threads: 'CPU 线程上限',
};
export const bounds: Record<string, [number, number, number]> = {
  resolution: [512, 3072, 32],
  padding: [0, 256, 1],
  feather: [0, 10, 0.1],
  offset: [-20, 20, 1],
  blackPoint: [0, 0.95, 0.01],
  whitePoint: [0.05, 1, 0.01],
  threads: [1, 16, 1],
};

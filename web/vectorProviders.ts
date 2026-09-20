export const engines = [
  {
    id: 'vectorizerCom',
    name: 'Vectorizer.com',
    description: '免费网页 · 效果一般',
    cost: '免费 · 自动网页转换',
    detail:
      '通过本机 Edge / Chrome 自动上传、转换并下载 SVG，无需手动导回、不消耗 Codex 额度。未公开模型/API；网站条款限制第三方集成，页面变化或验证可能导致失败。',
    links: [['网站来源', 'https://vectorizer.com/']],
  },
  {
    id: 'vectorizer',
    name: 'Vectorizer.AI 官方 API',
    description: '原厂直连 · 效果最好',
    cost: '按月订阅额度 · 每张扣 1 点',
    detail:
      '深度学习结合几何拟合，直接调用原厂矢量化。需单独的 API 套餐，网页会员不含 API；与 302 的按张充值独立。',
    links: [
      ['原厂官网', 'https://vectorizer.ai/'],
      ['申请官方 API 凭证', 'https://vectorizer.ai/api/documentation'],
      ['API 套餐价格', 'https://vectorizer.ai/pricing'],
    ],
  },
  {
    id: 'recraft',
    name: 'Recraft',
    description: '官方 API · 效果优秀',
    cost: '按张计费 · $0.01/张',
    detail:
      'Recraft 自有 AI 矢量化服务，位图转 SVG，适合标志、图标和插画。直接调用官方接口；API 余额与网页订阅分开。',
    links: [
      ['官网', 'https://www.recraft.ai/'],
      ['获取 API Key', 'https://www.recraft.ai/api'],
      ['官方价格', 'https://www.recraft.ai/pricing?tab=api'],
    ],
  },
  {
    id: 'vectorizer302',
    name: 'Vectorizer.AI · 302.AI',
    description: '国内转接 API · 效果最好',
    cost: '按张计费 · $0.30/张',
    detail:
      '通过 302.AI 调用 Vectorizer.AI；上游采用深度学习与几何拟合。302 按次扣费，单价高于官网订阅套餐的每张均价，但无需按月订阅 Vectorizer.AI。',
    links: [
      ['302.AI 接口来源', 'https://302.ai/product/detail/vectorize'],
      ['获取 302 API Key', 'https://dash.302.ai/'],
      ['Vectorizer.AI 官网', 'https://vectorizer.ai/'],
      ['官网包月价格', 'https://vectorizer.ai/pricing'],
    ],
  },
] as const;

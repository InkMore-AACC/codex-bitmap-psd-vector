export default function ModelStatus({ models }: { models?: Record<string, unknown> }) {
  const entries = [
    ['segmentation', 'U2NetP 粗抠'],
    ['birefnet', 'BiRefNet HR 精细抠图'],
    ['lucida', 'Lucida v7 精细抠图'],
  ];
  return (
    <div className="model-state">
      <b>本地模型与运行环境</b>
      <div className="model-status-list">
        {entries.map(([key, name]) => (
          <div key={key}>
            <span>{name}</span>
            <span className={models?.[key] === true ? 'model-ready' : ''}>
              {!models ? '读取中' : models[key] === true ? '已准备' : '未准备'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

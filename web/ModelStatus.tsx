export default function ModelStatus({ models }: { models?: Record<string, unknown> }) {
  const entries = [['segmentation', '本地粗抠']];
  return <div className="model-state"><b>本地模型与运行环境</b><div className="model-status-list">{entries.map(([key, name]) => <div key={key}><span>{name}</span><span className={models?.[key] === true ? 'model-ready' : ''}>{!models ? '读取中' : models[key] === true ? '已准备' : '未准备'}</span></div>)}</div></div>;
}

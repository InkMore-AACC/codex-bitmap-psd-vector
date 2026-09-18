import { useEffect, useState } from 'react';
import { api } from './api';
type Mode = 'auto' | 'mcp' | 'com' | 'disabled';
type Configuration = { photoshop: { mode: Mode; installed: boolean }; illustrator: { mode: Mode; installed?: boolean; url: string; hasToken: boolean } };
type Probe = { status: 'success' | 'partial' | 'failed' | 'disabled'; channels: {name:string;status:'success'|'failed'|'disabled';message:string}[] };
const labels = { success: '成功', partial: '部分成功', failed: '失败', disabled: '未启用' };

export default function AdobeSettings() {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Partial<Record<'photoshop'|'illustrator', Probe>>>({});
  const [details, setDetails] = useState('');
  const [checking, setChecking] = useState('');
  useEffect(() => { api<Configuration>('/api/adobe').then(setConfig).catch(error => {setMessage('读取连接配置失败');setDetails(String(error));}); }, []);
  const save = async () => {
    if (!config) return; setBusy(true);
    try { const result = await api<Configuration>('/api/adobe', { method: 'PATCH', body: JSON.stringify({ photoshop: { mode: config.photoshop.mode }, illustrator: { mode: config.illustrator.mode, url: config.illustrator.url, ...(secret.trim() ? { token: secret.trim() } : {}) } }) }); setConfig(result); setSecret(''); setResults({}); setDetails(''); setMessage('Adobe 连接配置已保存到本机'); }
    catch (error) { setMessage('保存失败，请查看详情'); setDetails(String(error)); } finally { setBusy(false); }
  };
  const probe = async (app: 'photoshop' | 'illustrator') => {
    setBusy(true); setChecking(app); setMessage('');
    try { const result = await api<Probe>('/api/adobe/probe', { method: 'POST', body: JSON.stringify({ app }) }); setResults(old => ({...old,[app]:result})); }
    catch (error) { setResults(old => ({...old,[app]:{status:'failed',channels:[{name:'连接检查',status:'failed',message:'未能完成检查，请确认画布服务正在运行'}],details:String(error)}})); } finally { setBusy(false); setChecking(''); }
  };
  return <div className="adobe-settings"><p className="settings-intro">最终交接使用本机 Adobe 软件；普通分层与矢量化不需要安装。自动模式优先可用连接，再使用脚本接口。</p>
    {config && <>{(['photoshop', 'illustrator'] as const).map(app => <div className="adobe-app" key={app}><div className="adobe-setting"><b>{app === 'photoshop' ? 'Photoshop' : 'Illustrator'}</b><label>连接方式<select aria-label={`${app} 连接方式`} value={config[app].mode} onChange={event => {setConfig({ ...config, [app]: { ...config[app], mode: event.target.value as Mode } });setResults(old=>({...old,[app]:undefined}));}}><option value="auto">自动选择</option><option value="mcp">MCP</option><option value="com">Windows 脚本接口</option><option value="disabled">不启用</option></select></label><button disabled={busy} onClick={() => void probe(app)}>{checking===app?'检查中…':'检查连接'}</button></div>{results[app]&&<div className={`adobe-result ${results[app]!.status}`} role="status"><b>{labels[results[app]!.status]}</b>{results[app]!.channels.map(c=><p key={c.name}>{c.name}：{labels[c.status]}<span> — {c.message}</span></p>)}<details><summary>查看详情</summary><pre className="adobe-connection-message">{JSON.stringify(results[app],null,2)}</pre></details></div>}</div>)}
      <p className="settings-note">Illustrator 官方 MCP 需要软件提供 MCP &amp; Tools 入口。正式版可使用 Windows 脚本接口。</p>
      <label className="credential">Illustrator MCP 本机地址<input value={config.illustrator.url} onChange={event => setConfig({ ...config, illustrator: { ...config.illustrator, url: event.target.value } })}/></label>
      <label className="credential">Illustrator MCP 密钥<span>{config.illustrator.hasToken ? '已配置' : '未配置'}</span><input type="password" autoComplete="new-password" value={secret} placeholder="留空保留已有密钥" onChange={event => setSecret(event.target.value)}/></label>
      <button className="primary" disabled={busy} onClick={() => void save()}>保存连接配置</button><p className="settings-note">更改连接设置后先保存，再检查连接。密钥不随画布项目导出。</p>
    </>}{message && <p role="status">{message}</p>}{details&&<details><summary>查看详情</summary><pre className="adobe-connection-message">{details}</pre></details>}
  </div>;
}

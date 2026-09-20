import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type AdobeApp = 'photoshop' | 'illustrator';
export type AdobeMode = 'auto' | 'mcp' | 'com' | 'disabled';
export interface AdobeSettings {
  photoshop: { mode: AdobeMode };
  illustrator: { mode: AdobeMode; url: string; token: string };
}
export type AdobeSettingsInput = {
  photoshop?: { mode?: AdobeMode };
  illustrator?: { mode?: AdobeMode; url?: string; token?: string; clearToken?: boolean };
};
const defaults: AdobeSettings = {
  photoshop: { mode: 'auto' },
  illustrator: { mode: 'auto', url: 'http://localhost:18412/v1/mcp', token: '' },
};
const run = promisify(execFile);
function protectToken(value: string, decrypt = false): Promise<string> {
  if (process.platform !== 'win32')
    return Promise.reject(new Error('Adobe 密钥保存仅支持 Windows DPAPI。'));
  const script = decrypt
    ? '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd());$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}'
    : '$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString $s))';
  return new Promise((resolve, reject) => {
    // A Node process started in PowerShell 7 inherits an incompatible PSModulePath.
    const environment = { ...process.env };
    for (const key of Object.keys(environment))
      if (key.toLowerCase() === 'psmodulepath') delete environment[key];
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, env: environment },
    );
    let output = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error('Windows 凭证加解密超时'));
    }, 15000);
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.resume();
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      code === 0 ? resolve(output) : reject(new Error('Windows 凭证加解密失败'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(value);
  });
}

export function validateAdobeUrl(value: string): string {
  const url = new URL(value);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Illustrator MCP 只允许无查询参数的本机 HTTP(S) 地址。');
  return url.href;
}

export function scopedAdobePath(scope: string, candidate: string, mustExist = false): string {
  const root = fs.realpathSync(scope),
    resolved = path.resolve(candidate);
  const parent = mustExist
    ? fs.realpathSync(resolved)
    : path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  const relative = path.relative(root, parent);
  if (
    !relative ||
    relative.startsWith('..' + path.sep) ||
    relative === '..' ||
    path.isAbsolute(relative)
  )
    throw new Error('Adobe 脚本及输出必须位于本次交接目录内。');
  return parent;
}

/** Only the agent MCP channel may invoke callTool / executeScript. Never expose them to browser routes. */
export class AdobeConnector {
  private settings: AdobeSettings;
  private clients = new Map<AdobeApp, Client>();
  private connecting = new Map<AdobeApp, Promise<Client>>();
  private configurationVersion = 0;
  private activeSecret = '';
  constructor(
    readonly root: string,
    readonly dataDir: string,
  ) {
    const file = path.join(dataDir, 'adobe-connections.json');
    this.settings = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : structuredClone(defaults);
  }
  publicSettings() {
    return {
      photoshop: { ...this.settings.photoshop, installed: fs.existsSync(this.photoshopEntry()) },
      illustrator: {
        mode: this.settings.illustrator.mode,
        url: this.settings.illustrator.url,
        hasToken: Boolean(this.settings.illustrator.token),
      },
    };
  }
  async configure(input: AdobeSettingsInput) {
    const next = structuredClone(this.settings);
    for (const app of ['photoshop', 'illustrator'] as const) {
      const mode = input[app]?.mode;
      if (mode !== undefined) {
        if (!['auto', 'mcp', 'com', 'disabled'].includes(mode))
          throw new Error('无效 Adobe 连接方式');
        next[app].mode = mode;
      }
    }
    if (input.illustrator?.url !== undefined)
      next.illustrator.url = validateAdobeUrl(input.illustrator.url);
    if (input.illustrator?.token) {
      if (input.illustrator.token.length > 4096 || /[\r\n]/.test(input.illustrator.token))
        throw new Error('无效 Illustrator 密钥');
      const token = input.illustrator.token.trim();
      next.illustrator.token = token ? 'dpapi:' + (await protectToken(token)) : '';
    }
    if (input.illustrator?.clearToken) next.illustrator.token = '';
    fs.mkdirSync(this.dataDir, { recursive: true });
    const file = path.join(this.dataDir, 'adobe-connections.json'),
      temporary = file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    this.configurationVersion++;
    this.settings = next;
    await this.close();
    return this.publicSettings();
  }
  photoshopEntry() {
    return path.join(
      this.root,
      'vendor',
      'photoshop-mcp',
      'node_modules',
      '@alisaitteke',
      'photoshop-mcp',
      'dist',
      'index.js',
    );
  }
  private configured(app: AdobeApp) {
    return app === 'photoshop'
      ? fs.existsSync(this.photoshopEntry())
      : Boolean(this.settings.illustrator.token);
  }
  private async connect(app: AdobeApp): Promise<Client> {
    if (this.settings[app].mode === 'disabled' || this.settings[app].mode === 'com')
      throw new Error('此应用未启用 MCP；可使用明确的原生脚本通道。');
    const existing = this.clients.get(app);
    if (existing) return existing;
    const pending = this.connecting.get(app);
    if (pending) return pending;
    if (!this.configured(app))
      throw new Error(
        app === 'photoshop'
          ? '社区 Photoshop MCP 尚未安装。'
          : '请从 Illustrator Beta 的 MCP & Tools 复制本机 URL 和密钥；正式版可用 COM。',
      );
    if (app === 'photoshop') {
      const manifest = JSON.parse(
        fs.readFileSync(path.resolve(this.photoshopEntry(), '../../package.json'), 'utf8'),
      );
      if (manifest.version !== '1.7.16')
        throw new Error('Photoshop MCP 版本与已验证适配器不符，请运行项目内固定版本安装脚本。');
    }
    const version = this.configurationVersion;
    const promise = (async () => {
      const client = new Client({ name: 'layer-canvas-adobe', version: '0.1.0' });
      const storedToken = this.settings.illustrator.token;
      const token =
        app === 'illustrator'
          ? storedToken.startsWith('dpapi:')
            ? await protectToken(storedToken.slice(6), true)
            : storedToken
          : '';
      if (token) this.activeSecret = token;
      const transport =
        app === 'photoshop'
          ? new StdioClientTransport({
              command: process.execPath,
              args: [this.photoshopEntry()],
              cwd: this.root,
              stderr: 'pipe',
              env: {
                ...Object.fromEntries(
                  Object.entries(process.env).filter(
                    (entry): entry is [string, string] => entry[1] !== undefined,
                  ),
                ),
                ANALYTICS_DISABLED: '1',
                POSTHOG_DISABLED: '1',
              },
            })
          : new StreamableHTTPClientTransport(
              new URL(validateAdobeUrl(this.settings.illustrator.url)),
              {
                requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' },
                fetch: async (url, init) => {
                  validateAdobeUrl(String(url));
                  return fetch(url, { ...init, redirect: 'error' });
                },
              },
            );
      if (transport instanceof StdioClientTransport) transport.stderr?.on('data', () => {});
      try {
        await client.connect(transport, { timeout: 20000 });
        if (version !== this.configurationVersion) throw new Error('连接设置已改变，请重试。');
      } catch (error) {
        await client.close().catch(() => {});
        throw error;
      }
      client.onclose = () => {
        if (this.clients.get(app) === client) this.clients.delete(app);
      };
      this.clients.set(app, client);
      return client;
    })();
    this.connecting.set(app, promise);
    try {
      return await promise;
    } finally {
      this.connecting.delete(app);
    }
  }
  async nativeProbe(app: AdobeApp) {
    if (process.platform !== 'win32')
      return { installed: false, running: false, error: '仅支持 Windows' };
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(this.root, 'scripts', 'adobe-native.ps1'),
        '-App',
        app,
        '-Operation',
        'Probe',
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
    );
    return JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
  }
  async probe(app: AdobeApp) {
    const native = await this.nativeProbe(app).catch((e) => ({
      installed: false,
      running: false,
      error: this.redact(String(e)),
    }));
    const mode = this.settings[app].mode;
    const channels: { name: string; status: 'success' | 'failed' | 'disabled'; message: string }[] =
      [];
    let toolCount = 0,
      mcpError = '';
    if (mode === 'disabled' || mode === 'com')
      channels.push({ name: 'MCP', status: 'disabled', message: '未启用' });
    else if (!this.configured(app))
      channels.push({
        name: 'MCP',
        status: 'failed',
        message: app === 'photoshop' ? '尚未安装连接组件' : '尚未配置 Illustrator 提供的地址和密钥',
      });
    else {
      try {
        const tools = await this.listTools(app);
        toolCount = tools.length;
        channels.push({
          name: 'MCP',
          status: 'success',
          message: '工具服务已连接；实际编辑能力在交接时检查',
        });
      } catch (error) {
        mcpError = this.redact(String(error));
        channels.push({
          name: 'MCP',
          status: 'failed',
          message: '工具服务未连接，请检查组件或地址和密钥',
        });
      }
    }
    if (mode === 'disabled' || mode === 'mcp')
      channels.push({ name: 'Windows 脚本', status: 'disabled', message: '未启用' });
    else
      channels.push({
        name: 'Windows 脚本',
        status: native.scriptConnected ? 'success' : 'failed',
        message: native.scriptConnected
          ? '已成功读取软件版本'
          : !native.installed
            ? '未检测到可用的软件安装'
            : !native.running
              ? '请先打开软件，再检查连接'
              : '软件已打开，但脚本读取失败',
      });
    const enabled = channels.filter((c) => c.status !== 'disabled'),
      successes = enabled.filter((c) => c.status === 'success');
    const status = !enabled.length
      ? 'disabled'
      : successes.length === enabled.length
        ? 'success'
        : successes.length
          ? 'partial'
          : 'failed';
    const route =
      mode === 'disabled'
        ? 'disabled'
        : channels[0].status === 'success'
          ? 'mcp'
          : mode === 'mcp'
            ? 'mcp'
            : 'com';
    return {
      app,
      route,
      native,
      connected: successes.length > 0,
      status,
      channels,
      toolCount,
      ...(mcpError ? { mcpError } : {}),
      note: '只读检查，不启动软件或修改文档。',
    };
  }
  async listTools(app: AdobeApp) {
    const client = await this.connect(app);
    const all: Awaited<ReturnType<Client['listTools']>>['tools'] = [];
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor ? { cursor } : undefined, { timeout: 20000 });
      all.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return all;
  }
  async callTool(
    app: AdobeApp,
    name: string,
    args: Record<string, unknown>,
    options: { allowAdobeCredits?: boolean } = {},
  ) {
    if (/generative_|generate_image|neural_filter/.test(name) && !options.allowAdobeCredits)
      throw new Error(
        '此 Adobe 工具可能消耗 Adobe/Firefly 额度；当前交接不包含该授权。请使用已有素材和原生编辑工具。',
      );
    const tools = await this.listTools(app);
    if (!tools.some((t) => t.name === name))
      throw new Error('Adobe MCP 未提供此工具，请先读取工具清单。');
    try {
      return await (
        await this.connect(app)
      ).callTool({ name, arguments: args }, undefined, { timeout: 120000 });
    } catch (error) {
      throw new Error(this.redact(String(error)));
    }
  }
  /** Scope checks constrain submitted file paths, NOT the capabilities of trusted ExtendScript. */
  async executeScript(
    app: AdobeApp,
    scriptPath: string,
    scopeDir: string,
    expectedOutputs: string[],
  ) {
    if (this.settings[app].mode === 'disabled') throw new Error('该 Adobe 应用连接已禁用。');
    if (process.platform !== 'win32') throw new Error('原生脚本仅支持 Windows。');
    const script = scopedAdobePath(scopeDir, scriptPath, true);
    if (
      !/\.jsx$/i.test(script) ||
      !fs.statSync(script).isFile() ||
      fs.statSync(script).size > 2 * 1024 * 1024
    )
      throw new Error('需要本次交接目录中的 JSX 脚本（最大 2MB）。');
    const outputs = expectedOutputs.map((output) => scopedAdobePath(scopeDir, output));
    if (
      !outputs.length ||
      outputs.some((output) => {
        try {
          fs.lstatSync(output);
          return true;
        } catch (e: any) {
          if (e.code === 'ENOENT') return false;
          throw e;
        }
      })
    )
      throw new Error('必须声明尚不存在的新输出文件；禁止覆盖已有产物。');
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(this.root, 'scripts', 'adobe-native.ps1'),
        '-App',
        app,
        '-Operation',
        'Run',
        '-ScriptPath',
        script,
      ],
      { windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
    );
    const execution = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    const artifacts = outputs.map((output) => {
      scopedAdobePath(scopeDir, output, true);
      const stat = fs.statSync(output);
      if (!stat.isFile() || !stat.size) throw new Error('脚本未生成声明的有效输出文件。');
      return { path: output, bytes: stat.size };
    });
    return {
      execution,
      artifacts,
      verified: false,
      note: '已执行并验证新文件存在；仍需打开并核对图层、文字和视觉一致性，再回传完成。',
    };
  }
  private redact(value: string) {
    const secret = this.activeSecret;
    return secret ? value.split(secret).join('[redacted]') : value;
  }
  async close() {
    const clients = [...this.clients.values()];
    this.clients.clear();
    await Promise.allSettled(clients.map((c) => c.close()));
  }
}

"""Export a clean source snapshot without private assets or local Git history."""
import argparse
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ROOT_FILES = ['README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CHANGELOG.md',
              '.gitignore', '.gitattributes', 'package.json', 'package-lock.json',
              'index.html', 'tsconfig.json', 'vite.config.ts']
DOCS = ['INSTALL', 'USER_GUIDE', 'TROUBLESHOOTING', 'ARCHITECTURE', 'DEVELOPMENT',
        'THIRD_PARTY', 'REQUIREMENTS', 'CONTRACT', 'ACCEPTANCE', 'RELEASE_CHECKLIST']
FOLDERS = ['server', 'web', 'bridge', 'python', 'scripts', 'plugins', '.github']
EXTENSIONS = {'.ts', '.tsx', '.css', '.json', '.md', '.py', '.ps1', '.mjs', '.txt', '.yml', '.yaml'}
EXCLUDED = {'scripts/load-demo.ts', 'scripts/e2e-models.ts', 'scripts/refresh-demo-previews.ts'}

def export(destination: Path):
    destination = destination.resolve()
    if destination.exists():
        raise SystemExit('Destination already exists; use a new directory. Nothing overwritten.')
    candidates = [ROOT / f for f in ROOT_FILES] + [ROOT / 'docs' / (name + '.md') for name in DOCS]
    for folder in FOLDERS:
        candidates.extend(p for p in (ROOT / folder).rglob('*') if p.is_file()
                          and p.suffix in EXTENSIONS and '__pycache__' not in p.parts
                          and 'node_modules' not in p.parts)
    # Tests are source files too; they generate their own non-sensitive fixtures.
    candidates.extend((ROOT / 'tests').glob('*.ts'))
    selected = sorted(set(p for p in candidates if p.relative_to(ROOT).as_posix() not in EXCLUDED
                          and p.name != '.mcp.json'))
    findings = []
    for source in selected:
        body = source.read_text(encoding='utf-8-sig')
        patterns = [r'gh[pousr]_[A-Za-z0-9]{30,}', r'github_pat_[A-Za-z0-9_]{40,}',
                    r'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
                    r'#token=[a-f0-9]{32,}', r'(?i)[A-Z]:[/\\]+Users[/\\]+(?!Public\b|Default\b)[^/\\\s]+']
        if any(re.search(pattern, body) for pattern in patterns):
            findings.append(source.relative_to(ROOT).as_posix())
        if source.stat().st_size > 5 * 1024 * 1024:
            findings.append(source.relative_to(ROOT).as_posix() + ' (over 5 MiB)')
    if findings:
        raise SystemExit('Review these files before export (values hidden): ' + ', '.join(findings))
    destination.mkdir(parents=True)
    for source in selected:
        relative = source.relative_to(ROOT)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    # Installation generates machine-specific values; publish a stable manifest version.
    manifest = destination / 'plugins/layer-canvas/.codex-plugin/plugin.json'
    value = json.loads(manifest.read_text(encoding='utf-8'))
    value['version'] = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version']
    manifest.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(selected), 'bytes': sum(p.stat().st_size for p in selected),
                      'credentialPatternFindings': 0, 'historyIncluded': False,
                      'note': 'Pattern scan is not a complete security audit; review before publishing.'}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('destination', type=Path)
    export(parser.parse_args().destination)

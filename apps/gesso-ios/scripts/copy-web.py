#!/usr/bin/python3
"""Copy the dependency-free offline shell on every build, then verify its manifest."""
import hashlib
import pathlib
import re
import shutil
import sys

source, target = map(pathlib.Path, sys.argv[1:])
excluded = {'e2e', 'test', 'design', 'ios', 'node_modules', 'package.json', 'package-lock.json', 'playwright.config.js'}
def ignore(directory, names):
    return [name for name in names if name.startswith('.') or name in excluded or name.endswith('.md')]

if target.exists():
    shutil.rmtree(target)
shutil.copytree(source, target, ignore=ignore)
shell = re.search(r'const SHELL\s*=\s*\[(.*?)\];', (source / 'sw.js').read_text(), re.S)
if not shell:
    raise SystemExit('Could not find the service-worker SHELL manifest.')
for name in re.findall(r"['\"](\./[^'\"]*)['\"]", shell.group(1)):
    path = target / name[2:]
    if name == './':
        path = target / 'index.html'
    if not path.is_file():
        raise SystemExit(f'Missing bundled SHELL resource: {name}')
digest = hashlib.sha256()
for path in sorted(p for p in target.rglob('*') if p.is_file()):
    digest.update(str(path.relative_to(target)).encode())
    digest.update(path.read_bytes())
(target / 'revision.txt').write_text(digest.hexdigest()[:16] + '\n')
print(f'Bundled Gesso web revision {digest.hexdigest()[:16]}')

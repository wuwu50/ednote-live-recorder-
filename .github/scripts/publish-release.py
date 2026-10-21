import base64, hashlib, json, os, subprocess
from pathlib import Path
import zipfile
repo = os.environ['REPOSITORY']
version = json.loads(Path('extension/manifest.json').read_text(encoding='utf-8'))['version']
installer = Path(f'dist/RednoteLiveRecorder-{version}-Setup.exe')
if not installer.is_file(): raise RuntimeError('Missing verified installer')
archive = Path(f'dist/RednoteLiveRecorder-{version}.zip')
with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as package:
    for file in sorted(Path('extension').rglob('*')):
        if file.is_file(): package.write(file, file.relative_to('extension').as_posix())
with zipfile.ZipFile(archive) as package:
    if package.testzip() is not None or 'manifest.json' not in package.namelist():
        raise RuntimeError('Invalid extension archive')
exists = subprocess.run(['gh','release','view',f'v{version}','--repo',repo], capture_output=True, text=True, encoding='utf-8')
if exists.returncode == 0: raise RuntimeError('Version already published; do not overwrite release assets')
subprocess.run(['gh','release','create',f'v{version}',str(archive),str(installer),'--repo',repo,'--target',os.environ['COMMIT'],'--title',f'小紅書直播錄影機 v{version}','--notes-file','RELEASE_NOTES.md'],check=True)

feed = {'version': version, 'downloadUrl': f'https://github.com/{repo}/releases/download/v{version}/RednoteLiveRecorder-{version}-Setup.exe', 'zipUrl': f'https://github.com/{repo}/releases/download/v{version}/RednoteLiveRecorder-{version}.zip', 'notes': Path('RELEASE_NOTES.md').read_text(encoding='utf-8')}
feed['sha256'] = hashlib.sha256(Path(f'dist/RednoteLiveRecorder-{version}-Setup.exe').read_bytes()).hexdigest()
content = json.dumps(feed, ensure_ascii=False, indent=2) + '\n'
result = subprocess.run(['gh','api',f'repos/{repo}/contents/version.json?ref=main'], capture_output=True, text=True, encoding='utf-8')
if result.returncode:
    # Allow a missing initial feed; other API failures must stop publication.
    if '404' not in result.stderr:
        raise RuntimeError(result.stderr)
    sha = None
else:
    sha = json.loads(result.stdout)['sha']
payload = {'message': f'Publish update feed for v{version}', 'branch': 'main', 'content': base64.b64encode(content.encode()).decode()}
if sha: payload['sha'] = sha
subprocess.run(['gh','api','--method','PUT',f'repos/{repo}/contents/version.json','--input','-'], input=json.dumps(payload), text=True, check=True, stdout=subprocess.DEVNULL)

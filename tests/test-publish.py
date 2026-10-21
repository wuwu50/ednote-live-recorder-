import base64
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
from unittest.mock import patch
import zipfile

script = Path(__file__).resolve().parents[1] / '.github/scripts/publish-release.py'
previous = Path.cwd()
test_root = (previous / 'build').resolve()
assert test_root.is_relative_to(previous.resolve())
test_root.mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='recorder-release-',dir=test_root) as temp:
    try:
        os.chdir(temp)
        Path('extension/vendor').mkdir(parents=True)
        Path('dist').mkdir()
        Path('extension/manifest.json').write_text(json.dumps({'version':'1.13.0'}), encoding='utf-8')
        Path('extension/vendor/test.mjs').write_text('export const value = 1;', encoding='utf-8')
        notes = '背景儲存測試：原始影片保留。'
        Path('RELEASE_NOTES.md').write_text(notes, encoding='utf-8')
        binary = b'test installer bytes'
        Path('dist/RednoteLiveRecorder-1.13.0-Setup.exe').write_bytes(binary)
        calls = []

        def gh(args, **kwargs):
            calls.append((args,kwargs))
            if args[1:3] == ['release','view']:
                return subprocess.CompletedProcess(args,1,stdout='',stderr='not found')
            if args[1] == 'api' and args[2] != '--method':
                return subprocess.CompletedProcess(args,0,stdout=json.dumps({'sha':'previous-sha'}))
            return subprocess.CompletedProcess(args,0,stdout='')

        with patch.dict(os.environ, {'REPOSITORY':'wuwu50/ednote-live-recorder-','COMMIT':'test-commit'}), patch('subprocess.run', side_effect=gh):
            runpy.run_path(str(script),run_name='__main__')
        with zipfile.ZipFile('dist/RednoteLiveRecorder-1.13.0.zip') as archive:
            assert archive.testzip() is None
            assert 'manifest.json' in archive.namelist()
            assert 'vendor/test.mjs' in archive.namelist()
            assert not any(name.startswith('extension/') for name in archive.namelist())
        create = next(args for args,kwargs in calls if args[1:3] == ['release','create'])
        assert '--target' in create and 'test-commit' in create
        payload = json.loads(calls[-1][1]['input'])
        feed = json.loads(base64.b64decode(payload['content']).decode('utf-8'))
        assert feed['notes'] == notes
        assert feed['sha256'] == hashlib.sha256(binary).hexdigest()
        assert payload['sha'] == 'previous-sha'
        print('PASS: direct release builds valid ZIP and publishes correct SHA256 feed with Traditional Chinese notes.')
    finally:
        os.chdir(previous)

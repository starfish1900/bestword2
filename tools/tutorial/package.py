"""Bundle the exact game/tutorial sources and local production assets."""
from pathlib import Path
import hashlib
import json
import os
import subprocess
import zipfile

source = Path(__file__).resolve().parent
repository = source.parents[1]
task = repository.parents[1]
work = Path(os.environ.get('BESTWORD_TUTORIAL_WORK', task / 'work/tutorial'))
output = Path(os.environ.get('BESTWORD_TUTORIAL_OUTPUT', task / 'outputs/bestword-tutorial'))
destination = output / 'BestWord-Tutorial-Source.zip'
files = {}

tracked = subprocess.check_output(['git', 'ls-files', '-z'], cwd=repository).decode('utf-8').split('\0')
for name in tracked:
    if name:
        path = repository / name
        if path.is_file():
            files['bestword/' + name.replace('\\', '/')] = path
for path in source.rglob('*'):
    if path.is_file() and not any(part in ('node_modules', 'dist', '__pycache__') for part in path.relative_to(source).parts):
        files['bestword/' + path.relative_to(repository).as_posix()] = path
for folder in ('audio', 'capture', 'render', 'final-review'):
    for path in (work / folder).rglob('*'):
        if not path.is_file():
            continue
        if folder == 'capture' and ('raw' in path.relative_to(work / folder).parts or path.name == 'capture-first-attempt.json'):
            continue
        if folder == 'render' and path.suffix not in ('.mp4', '.json', '.ass'):
            continue
        files['work/tutorial/' + path.relative_to(work).as_posix()] = path
files['work/tutorial/timeline.json'] = work / 'timeline.json'
files['verification/Frame-layout-inspection.json'] = work / 'inspection/inspection.json'
files['REPRODUCING.md'] = source / 'REPRODUCING.md'
for name in ('Verification.json', 'Browser-playback-verification.json', 'Viewer-verification.json', 'Portability-verification.json', 'Production-report.md', 'Scene-manifest.json', 'Audio-normalization.json'):
    if (output / name).is_file():
        files['verification/' + name] = output / name
for name in ('Watch-BestWord.html', 'README.md'):
    files['viewer/' + name] = output / name

manifest = []
with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for name, path in sorted(files.items()):
        data = path.read_bytes()
        archive.writestr(name, data)
        manifest.append({'file': name, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
    archive.writestr('Source-package-manifest.json', json.dumps({'files': manifest}, indent=2))
with zipfile.ZipFile(destination) as archive:
    bad = archive.testzip()
    if bad:
        raise RuntimeError('ZIP checksum failure: ' + bad)
    required = ['bestword/package-lock.json', 'bestword/tools/tutorial/pipeline.mjs', 'work/tutorial/audio/welcome.wav', 'work/tutorial/capture/clips/onboarding.mp4', 'work/tutorial/render/score-anopias.mp4', 'REPRODUCING.md']
    for name in required:
        if name not in archive.namelist():
            raise RuntimeError('Missing reproducibility asset: ' + name)
digest = hashlib.sha256(destination.read_bytes()).hexdigest()
(output / 'BestWord-Tutorial-Source.sha256').write_text(digest + '  ' + destination.name + '\n', encoding='utf-8')
print(json.dumps({'archive': str(destination), 'files': len(files), 'bytes': destination.stat().st_size, 'sha256': digest, 'zipIntegrity': 'passed'}))

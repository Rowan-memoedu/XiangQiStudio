import json
from studio.runtime import Runtime
from studio.store import Store


def test_changed_maven_layout_refreshes_only_disposable_language_state(tmp_path):
    store = Store(tmp_path)
    files = {'pom.xml': b'<sourceDirectory>src</sourceDirectory>',
             'src/Main.java': b'class Main {}', '.settings/user.prefs': b'keep'}
    store.seed(files)
    runtime = Runtime(store)
    root = runtime.directories('test-a')
    project = store.project_dir('test-a')
    (project / '.classpath').write_text('old source roots')
    index = root / 'language/workspace'; index.mkdir()
    (index / 'old-index').write_text('old model')
    cache = root / 'language/m2'; cache.mkdir(); (cache / 'dependency').write_text('keep')
    runtime.prepare_language('test-a', root)
    assert not index.exists() and not (project / '.classpath').exists()
    assert (project / '.settings/user.prefs').read_bytes() == b'keep'
    assert (project / 'src/Main.java').read_bytes() == files['src/Main.java']
    assert (cache / 'dependency').read_text() == 'keep'
    index.mkdir(); (index / 'fresh').write_text('keep while pom unchanged')
    runtime.prepare_language('test-a', root)
    assert (index / 'fresh').exists()
    (project / 'pom.xml').write_text('<sourceDirectory>code</sourceDirectory>')
    runtime.prepare_language('test-a', root)
    assert not index.exists()

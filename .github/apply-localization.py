import hashlib, json, lzma, pathlib, sys
payload = pathlib.Path(sys.argv[1]).read_bytes()
assert hashlib.sha256(payload).hexdigest() == 'f190b6bb71cfc7072b5d0a046b9ed2800db71703942be43bd1dc5159e157d3e3'
items = json.loads(lzma.decompress(payload))
root = pathlib.Path.cwd().resolve()
assert len(items) == 38
for name, before, after, edits in items:
    path = (root / name).resolve()
    assert path.is_relative_to(root) and '.git' not in pathlib.Path(name).parts
    old = path.read_bytes() if path.exists() else b''
    assert hashlib.sha256(old).hexdigest() == before, name + ': base mismatch'
    text = old.decode('utf-8')
    for start, end, replacement in reversed(edits):
        assert 0 <= start <= end <= len(text)
        text = text[:start] + replacement + text[end:]
    data = text.encode('utf-8')
    assert hashlib.sha256(data).hexdigest() == after, name + ': result mismatch'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(name)

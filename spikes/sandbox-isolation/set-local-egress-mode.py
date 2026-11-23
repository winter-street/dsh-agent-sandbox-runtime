"""Explicit local deployment edit. Requires operator authorization; never prints config secrets."""
import copy
import pathlib
import re
import sys
import tomllib
import yaml

try:
    path = pathlib.Path(sys.argv[1]).resolve(strict=True)
    raw = path.read_text(encoding='utf-8-sig')
    before = yaml.safe_load(raw)
    original = tomllib.loads(before['configs']['opensandbox-config']['content'])
    if original.get('egress', {}).get('mode', 'dns') != 'dns':
        raise ValueError('Expected initial dns profile')
    matches = list(re.finditer(r'(?m)^([ \t]*)\[egress\][ \t]*$', raw))
    if len(matches) != 1:
        raise ValueError('Expected one embedded egress section')
    match = matches[0]
    edited = raw[:match.end()] + '\n' + match.group(1) + 'mode = "dns+nft"' + raw[match.end():]
    after = yaml.safe_load(edited)
    actual = tomllib.loads(after['configs']['opensandbox-config']['content'])
    expected = copy.deepcopy(original)
    expected['egress']['mode'] = 'dns+nft'
    if actual != expected:
        raise ValueError('Unexpected TOML semantic change')
    normalized = copy.deepcopy(after)
    normalized['configs']['opensandbox-config']['content'] = before['configs']['opensandbox-config']['content']
    if normalized != before:
        raise ValueError('Unexpected Compose semantic change')
    backup = path.with_name(path.stem + '.before-dns-nft.yaml')
    if backup.exists():
        raise ValueError('Backup exists; review rather than overwrite')
    backup.write_bytes(path.read_bytes())
    path.write_text(edited, encoding='utf-8')
    print('Updated only embedded egress.mode from dns to dns+nft; original preserved locally; secrets not printed.')
except Exception as error:
    print('Local edit failed: ' + type(error).__name__, file=sys.stderr)
    sys.exit(1)

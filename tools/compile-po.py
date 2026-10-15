#!/usr/bin/env python3
# Compiles a .po file into a .mo file without needing gettext installed.
# Usage: compile-po.py file.po -o file.mo
# Supports msgid, msgid_plural, msgstr and msgstr[n]; untranslated entries are skipped.
import ast, struct, sys
args = sys.argv[1:]; out = None; src = None
i = 0
while i < len(args):
    a = args[i]
    if a == '-o': out = args[i+1]; i += 2; continue
    if a.startswith('--output-file='): out = a.split('=',1)[1]
    elif not a.startswith('-'): src = a
    i += 1
entries = {}; cur = {}; key = None
def flush():
    global cur
    if 'msgid' in cur:
        mid = cur['msgid'] + ('\0' + cur['msgid_plural'] if 'msgid_plural' in cur else '')
        strs = [cur[k] for k in sorted(k for k in cur if k.startswith('msgstr'))]
        if all(strs) or mid == '':
            entries[mid] = '\0'.join(strs)
    cur = {}
for line in open(src, encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    if line.startswith('"'):
        cur[key] += ast.literal_eval(line); continue
    k, v = line.split(' ', 1)
    if k == 'msgid' and 'msgstr' in ''.join(cur): flush()
    key = k; cur[k] = ast.literal_eval(v)
flush()
keys = sorted(entries); ids = b''; strs = b''; offs = []
for k in keys:
    kb, vb = k.encode(), entries[k].encode()
    offs.append((len(kb), len(ids), len(vb), len(strs))); ids += kb + b'\0'; strs += vb + b'\0'
n = len(keys); ks = 7*4; vs = ks + n*8; idst = vs + n*8; sst = idst + len(ids)
out_b = struct.pack('Iiiiiii', 0x950412de, 0, n, ks, vs, 0, 0)
out_b += b''.join(struct.pack('ii', l, idst+o) for l, o, _, _ in offs)
out_b += b''.join(struct.pack('ii', l, sst+o) for _, _, l, o in offs)
open(out, 'wb').write(out_b + ids + strs)

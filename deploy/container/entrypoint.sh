#!/bin/sh
# The dev container's first process (Dockerfile). systemd starts each service with an environment of
# its own, so the one compose gives the container (compose.yaml: DATA_DIR, SPEECH_URL, and TZ and the
# rest from .env) is written to /etc/dispatch/env for dispatch.service, which reads it (dispatch.conf).
# Then it becomes systemd.
set -eu
install -d -m 0700 /etc/dispatch
python3 - <<'EOF'
import json, os
# What the container's own shell set, and what systemd sets for each service itself.
skip = {'PATH', 'HOME', 'HOSTNAME', 'TERM', 'SHLVL', 'PWD', 'OLDPWD', '_', 'container', 'DEBIAN_FRONTEND'}
lines = ['%s=%s' % (k, json.dumps(v, ensure_ascii=False)) for k, v in sorted(os.environ.items()) if k not in skip and '\n' not in v]
fd = os.open('/etc/dispatch/env', os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write('\n'.join(lines) + '\n')
EOF
exec /sbin/init

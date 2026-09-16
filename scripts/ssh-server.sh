#!/usr/bin/env sh
# Starts a throwaway OpenSSH server for `QUERYCRAFT_TEST_SSH=1 cargo test --test live_ssh`
# and joins it with the database containers from docker-compose.yml / tls-servers.sh on a
# shared docker network, so the tunnel target is `querycraft-mariadb:3306` etc.
# User `qc` accepts the password `secret`, the generated key `id_ed25519` (no passphrase)
# and `id_ed25519_pass` (passphrase `secret`). Published on port 33075.
set -eu

dir="${TMPDIR:-/tmp}/querycraft-ssh"
mkdir -p "$dir"
cd "$dir"

if [ ! -f id_ed25519 ]; then
  ssh-keygen -q -t ed25519 -N "" -f id_ed25519
  ssh-keygen -q -t ed25519 -N "secret" -f id_ed25519_pass
  cat id_ed25519.pub id_ed25519_pass.pub > authorized_keys
fi

docker network create querycraft >/dev/null 2>&1 || true
for c in querycraft-mysql querycraft-mariadb querycraft-postgres querycraft-clickhouse; do
  docker network connect querycraft "$c" >/dev/null 2>&1 || true
done

docker rm -f querycraft-ssh >/dev/null 2>&1 || true
docker run -d --name querycraft-ssh --network querycraft -p 33075:22 -v "$dir:/keys:ro" alpine:3.20 sh -c '
  apk add --no-cache openssh >/dev/null &&
  ssh-keygen -A &&
  adduser -D qc && echo "qc:secret" | chpasswd &&
  mkdir -p /home/qc/.ssh && cp /keys/authorized_keys /home/qc/.ssh/authorized_keys &&
  chown -R qc:qc /home/qc/.ssh && chmod 700 /home/qc/.ssh && chmod 600 /home/qc/.ssh/authorized_keys &&
  sed -i -E "s/^#?AllowTcpForwarding .*/AllowTcpForwarding yes/; s/^#?PasswordAuthentication .*/PasswordAuthentication yes/" /etc/ssh/sshd_config &&
  exec /usr/sbin/sshd -D -e'

echo "SSH server started on 127.0.0.1:33075; keys in $dir"

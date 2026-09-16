#!/usr/bin/env sh
# Starts throwaway PostgreSQL, ClickHouse and MariaDB containers that present a
# self-signed certificate, for `QUERYCRAFT_TEST_TLS=1 cargo test --test live_tls`.
# MySQL from docker-compose.yml already enables TLS with its own certificate.
# Ports match docker-compose.yml; ClickHouse HTTPS is published on 33074.
set -eu

dir="${TMPDIR:-/tmp}/querycraft-tls"
mkdir -p "$dir"
cd "$dir"

if [ ! -f server.crt ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.crt -days 365 -subj "/CN=QueryCraft Test CA"
  openssl req -newkey rsa:2048 -nodes -keyout server.key -out server.csr -subj "/CN=localhost"
  printf 'subjectAltName=DNS:localhost,IP:127.0.0.1\n' > san.ext
  openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -out server.crt -days 365 -extfile san.ext
  chmod 644 server.key
fi

cat > clickhouse-tls.xml <<'XML'
<clickhouse>
  <https_port>8443</https_port>
  <openSSL>
    <server>
      <certificateFile>/etc/clickhouse-server/tls/server.crt</certificateFile>
      <privateKeyFile>/etc/clickhouse-server/tls/server.key</privateKeyFile>
      <verificationMode>none</verificationMode>
      <loadDefaultCAFile>true</loadDefaultCAFile>
    </server>
  </openSSL>
</clickhouse>
XML

docker rm -f querycraft-postgres querycraft-clickhouse querycraft-mariadb >/dev/null 2>&1 || true

# PostgreSQL insists on a key file owned by its own user with mode 0600, so copy it in first.
docker run -d --name querycraft-postgres -p 33071:5432 \
  -e POSTGRES_PASSWORD=secret -e POSTGRES_DB=shop -v "$dir:/tls:ro" --entrypoint sh postgres:16 -c '
    cp /tls/server.crt /tls/server.key /var/lib/postgresql/ &&
    chown postgres:postgres /var/lib/postgresql/server.* && chmod 600 /var/lib/postgresql/server.key &&
    exec docker-entrypoint.sh postgres -c ssl=on \
      -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key'

docker run -d --name querycraft-clickhouse -p 33072:8123 -p 33074:8443 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD=secret -e CLICKHOUSE_DB=shop \
  -v "$dir:/etc/clickhouse-server/tls:ro" \
  -v "$dir/clickhouse-tls.xml:/etc/clickhouse-server/config.d/tls.xml:ro" \
  clickhouse/clickhouse-server:24.8

docker run -d --name querycraft-mariadb -p 33073:3306 \
  -e MARIADB_ROOT_PASSWORD=secret -e MARIADB_DATABASE=shop -v "$dir:/tls:ro" mariadb:11 \
  --ssl-cert=/tls/server.crt --ssl-key=/tls/server.key --ssl-ca=/tls/ca.crt

echo "TLS servers started; certificates in $dir"

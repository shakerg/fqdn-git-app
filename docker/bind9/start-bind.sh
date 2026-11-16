#!/bin/sh
# Lab-only BIND9 bootstrap: renders the TSIG key from $LAB_TSIG_SECRET and starts named.
set -eu
mkdir -p /var/cache/bind /etc/bind/lab
cat > /etc/bind/lab/dnspool.key <<EOF
key "dnspool-key" {
  algorithm hmac-sha256;
  secret "${LAB_TSIG_SECRET}";
};
EOF
cp /docker/named.conf /etc/bind/named.conf
[ -f /var/cache/bind/db.lab.internal ] || cp /docker/db.lab.internal /var/cache/bind/db.lab.internal
chown -R bind:bind /var/cache/bind /etc/bind/lab 2>/dev/null || true
exec /usr/sbin/named -g -c /etc/bind/named.conf -u bind

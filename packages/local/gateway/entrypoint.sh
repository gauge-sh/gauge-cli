#!/bin/sh
set -eu
mkdir -p /gateway/private
chmod 0700 /gateway/private
chown 65532:65532 /gateway/private
if [ -f /gateway/connections.json ]; then
  install -m 0600 -o 65532 -g 65532 /gateway/connections.json /gateway/private/connections.json
fi
# These rules belong only to this container's network namespace. The workload
# shares that namespace, without NET_ADMIN or a proxy process of its own.
iptables -t nat -N GAUGE
iptables -t nat -A OUTPUT -p tcp -j GAUGE
iptables -t nat -A GAUGE -m owner --uid-owner 65532 -j RETURN
iptables -t nat -A GAUGE -d 127.0.0.0/8 -j RETURN
iptables -t nat -A GAUGE -p tcp -m multiport --dports 80,443 -j REDIRECT --to-ports 8080
iptables -A OUTPUT -p udp --dport 443 -j REJECT --reject-with icmp-port-unreachable
exec setpriv --reuid 65532 --regid 65532 --clear-groups \
  --bounding-set=-all --inh-caps=-all --no-new-privs \
  mitmdump --quiet --mode transparent --listen-host 127.0.0.1 --listen-port 8080 \
  --set confdir=/gateway/private --set connection_strategy=lazy \
  --set ssl_insecure=false --set upstream_cert=false -s /gateway/fixtures.py

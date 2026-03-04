#!/bin/sh
set -eu

apply_firewall() {
  iptables -N TS-LOCKDOWN 2>/dev/null || true
  iptables -F TS-LOCKDOWN

  if ! iptables -C INPUT -j TS-LOCKDOWN >/dev/null 2>&1; then
    iptables -I INPUT 1 -j TS-LOCKDOWN
  fi

  iptables -A TS-LOCKDOWN -i lo -j ACCEPT
  iptables -A TS-LOCKDOWN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  iptables -A TS-LOCKDOWN -i tailscale0 -j ACCEPT
  iptables -A TS-LOCKDOWN -i eth0 -p udp --dport 41641 -j ACCEPT
  iptables -A TS-LOCKDOWN -j DROP

  iptables -P INPUT DROP
  iptables -P OUTPUT ACCEPT

  if command -v ip6tables >/dev/null 2>&1; then
    ip6tables -N TS-LOCKDOWN 2>/dev/null || true
    ip6tables -F TS-LOCKDOWN

    if ! ip6tables -C INPUT -j TS-LOCKDOWN >/dev/null 2>&1; then
      ip6tables -I INPUT 1 -j TS-LOCKDOWN
    fi

    ip6tables -A TS-LOCKDOWN -i lo -j ACCEPT
    ip6tables -A TS-LOCKDOWN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    ip6tables -A TS-LOCKDOWN -i tailscale0 -j ACCEPT
    ip6tables -A TS-LOCKDOWN -i eth0 -p udp --dport 41641 -j ACCEPT
    ip6tables -A TS-LOCKDOWN -j DROP

    ip6tables -P INPUT DROP
    ip6tables -P OUTPUT ACCEPT
  fi
}

/usr/local/bin/containerboot &
CONTAINERBOOT_PID="$!"

trap 'kill "${CONTAINERBOOT_PID}" 2>/dev/null || true' INT TERM

while kill -0 "${CONTAINERBOOT_PID}" 2>/dev/null; do
  apply_firewall || echo "warning: failed to apply firewall rules, will retry" >&2
  sleep 20
done

wait "${CONTAINERBOOT_PID}"

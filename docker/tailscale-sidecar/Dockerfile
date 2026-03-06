FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    iptables \
    procps \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    > /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    > /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends tailscale \
 && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/tailscale-sidecar-entrypoint.sh
RUN chmod +x /usr/local/bin/tailscale-sidecar-entrypoint.sh \
 && mkdir -p /var/lib/tailscale /var/run/tailscale

ENTRYPOINT ["/usr/local/bin/tailscale-sidecar-entrypoint.sh"]

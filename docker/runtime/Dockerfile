FROM debian:trixie-slim

ARG DEV_USER=dev
ARG DEV_UID=1000
ARG DEV_GID=1000

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    gnupg \
 && mkdir -p /etc/apt/keyrings \
 && curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.noarmor.gpg \
    > /usr/share/keyrings/tailscale-archive-keyring.gpg \
 && curl -fsSL https://pkgs.tailscale.com/stable/debian/trixie.tailscale-keyring.list \
    > /etc/apt/sources.list.d/tailscale.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    vim \
    tmux \
    mosh \
    zsh \
    git \
    sudo \
    ripgrep \
    less \
    procps \
    iproute2 \
    xz-utils \
    unzip \
    nodejs \
    tailscale \
 && npm install -g @openai/codex @google/gemini-cli@latest \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${DEV_GID}" "${DEV_USER}" \
 && useradd --uid "${DEV_UID}" --gid "${DEV_GID}" --create-home --shell /usr/bin/zsh "${DEV_USER}" \
 && mkdir -p /workspace /var/lib /var/run/tailscale \
 && rm -rf /var/lib/tailscale \
 && ln -s /workspace/.tailscale /var/lib/tailscale \
 && chown -R "${DEV_USER}:${DEV_USER}" /workspace \
 && echo "${DEV_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-dev-user \
 && chmod 0440 /etc/sudoers.d/90-dev-user

COPY dev-entrypoint.sh /usr/local/bin/dev-entrypoint.sh
RUN chmod +x /usr/local/bin/dev-entrypoint.sh

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]

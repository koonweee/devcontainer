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
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    vim \
    tmux \
    mosh \
    zsh \
    git \
    openssh-server \
    sudo \
    ripgrep \
    less \
    procps \
    iproute2 \
    xz-utils \
    unzip \
    nodejs \
 && npm install -g @openai/codex @google/gemini-cli@latest \
 && npm cache clean --force \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --gid "${DEV_GID}" "${DEV_USER}" \
 && useradd --uid "${DEV_UID}" --gid "${DEV_GID}" --create-home --shell /usr/bin/zsh "${DEV_USER}" \
 && mkdir -p /workspace /var/run/sshd \
 && chown -R "${DEV_USER}:${DEV_USER}" /workspace \
 && echo "${DEV_USER} ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/90-dev-user \
 && chmod 0440 /etc/sudoers.d/90-dev-user

COPY sshd_config /etc/ssh/sshd_config
COPY dev-entrypoint.sh /usr/local/bin/dev-entrypoint.sh
RUN chmod +x /usr/local/bin/dev-entrypoint.sh

WORKDIR /workspace

EXPOSE 22 3000

ENTRYPOINT ["/usr/local/bin/dev-entrypoint.sh"]

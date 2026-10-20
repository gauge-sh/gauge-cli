FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates jq curl \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g \
      @anthropic-ai/claude-code@2.1.300 \
      @openai/codex@0.162.1 \
      opencode-ai@1.18.30 \
      @earendil-works/pi-coding-agent@1.1.0 \
 && npm cache clean --force
ENV NPM_CONFIG_PREFIX="/gauge/session/npm"
ENV PATH="/gauge/session/npm/bin:${PATH}"
COPY --chmod=0644 gauge-path.sh /etc/profile.d/gauge-path.sh
RUN mkdir -p /gauge/session && chown node:node /gauge/session
USER node
WORKDIR /home/node
LABEL sh.gauge.contract="1"

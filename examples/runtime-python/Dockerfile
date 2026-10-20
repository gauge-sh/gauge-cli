ARG GAUGE_RUNTIME=ghcr.io/gauge-sh/gauge-runtime:0.1.0
FROM ${GAUGE_RUNTIME}
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv \
 && rm -rf /var/lib/apt/lists/*
USER node

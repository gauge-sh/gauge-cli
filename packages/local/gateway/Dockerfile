FROM mitmproxy/mitmproxy@sha256:2711066c855659b5af8b1dbb84494ed3eff69b42ece439c60b4fe09a2db829d4
USER root
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
 && rm -rf /var/lib/apt/lists/*
COPY --chmod=0755 entrypoint.sh /gateway/entrypoint.sh
COPY fixtures.py health.py /gateway/
LABEL sh.gauge.contract="gateway-1"
HEALTHCHECK --interval=1s --timeout=2s --start-period=2s --retries=3 CMD ["python", "/gateway/health.py"]
ENTRYPOINT ["/gateway/entrypoint.sh"]
CMD []

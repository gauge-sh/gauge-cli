FROM gauge-runtime:dev
USER root
RUN rm /usr/local/bin/claude
COPY agent.mjs /usr/local/bin/claude
COPY git.sh /usr/local/bin/git
RUN chmod 755 /usr/local/bin/claude /usr/local/bin/git
USER node

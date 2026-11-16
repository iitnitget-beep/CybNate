# CybNate server: a small Linux machine for the app's commands, language servers, secrets and sign-ins.
#   docker build -t cybnate-server server/
#   docker run -d --init --name cybnate -p 8787:8787 -v cybnate-data:/data \
#     -e CYB_ACCESS_KEY="$(openssl rand -hex 24)" -e CYB_PUBLIC_URL=https://your.address cybnate-server
FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl wget git openssh-client python3 python3-pip python3-venv python-is-python3 \
      build-essential sqlite3 jq zip unzip less procps \
    && rm -rf /var/lib/apt/lists/*
# language servers: TypeScript/JavaScript and Python
RUN npm install -g typescript@5 typescript-language-server@4 pyright@1 && npm cache clean --force

WORKDIR /app
COPY package.json index.js ./
COPY src ./src

ENV NODE_ENV=production PORT=8787 CYB_DATA_DIR=/data NODE_NO_WARNINGS=1
VOLUME /data
EXPOSE 8787
# Runs as root on purpose: each app user gets an own Unix user id for commands, which only root can assign.
# The container is the outer wall; do not add --privileged or mount the Docker socket.
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "index.js"]

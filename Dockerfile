FROM node:26-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY bin ./bin
COPY src ./src
ENV ENGRAM_HOME=/data \
    ENGRAM_HOST=0.0.0.0 \
    ENGRAM_PORT=7432 \
    ENGRAM_ALLOWED_HOSTS=* \
    NODE_ENV=production
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 7432
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:7432/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "bin/engram.js", "daemon", "run"]

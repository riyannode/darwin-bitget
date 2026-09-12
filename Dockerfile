FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY public ./public
COPY src ./src
COPY demo ./demo
COPY tsconfig.json ./tsconfig.json

ENV JUDGE_DEMO=true
ENV PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "demo/server.ts"]

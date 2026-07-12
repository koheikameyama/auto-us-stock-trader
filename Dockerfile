# US 相場局面モニター web サーバー（Hono + tsx）
FROM node:22-slim

WORKDIR /app

# Prisma が必要とする OpenSSL
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# 依存インストール（tsx は devDependency のため dev も含めて入れる）
COPY package.json package-lock.json* ./
RUN npm ci

# Prisma スキーマ → クライアント生成
COPY prisma ./prisma
RUN npx prisma generate

# アプリ本体
COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["bash", "start.sh"]

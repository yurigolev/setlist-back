FROM node:24-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY drizzle ./drizzle
COPY openapi.yaml ./openapi.yaml
RUN npm run build
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]

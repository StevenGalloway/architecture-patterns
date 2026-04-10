FROM node:20-alpine AS base
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install
COPY src/ ./src/
RUN npm run build

FROM base AS management-api
COPY flags/ ./flags/
CMD ["node", "dist/management-api.js"]

FROM base AS demo-app
CMD ["node", "dist/demo-app.js"]

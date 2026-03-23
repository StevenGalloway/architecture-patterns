FROM oven/bun:1.1.29-alpine
WORKDIR /app
COPY package.json index.ts ./
EXPOSE 8080
ENV PORT=8080
CMD ["bun","run","index.ts"]

FROM oven/bun:1.1.29-alpine
WORKDIR /app
COPY package.json index.ts ./
EXPOSE 9800
ENV PORT=9800
CMD ["bun","run","index.ts"]

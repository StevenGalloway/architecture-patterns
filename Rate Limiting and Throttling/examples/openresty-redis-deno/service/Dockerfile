FROM denoland/deno:alpine-1.46.3
WORKDIR /app
COPY server.ts .
EXPOSE 9400
CMD ["run", "--allow-net", "server.ts"]

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod .
RUN go mod download
COPY . .
RUN go build -o /out/orchestrator .

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/orchestrator /app/orchestrator
EXPOSE 8080
CMD ["/app/orchestrator"]

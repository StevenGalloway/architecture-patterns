FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod .
RUN go mod download
COPY . .
RUN go build -o /out/payment .

FROM alpine:3.20
WORKDIR /app
COPY --from=build /out/payment /app/payment
CMD ["/app/payment"]

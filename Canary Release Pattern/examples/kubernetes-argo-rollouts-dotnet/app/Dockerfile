FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY src/CanaryDemo/CanaryDemo.csproj src/CanaryDemo/
RUN dotnet restore src/CanaryDemo/CanaryDemo.csproj
COPY src/CanaryDemo src/CanaryDemo
RUN dotnet publish src/CanaryDemo/CanaryDemo.csproj -c Release -o /app/publish

FROM mcr.microsoft.com/dotnet/aspnet:8.0
WORKDIR /app
COPY --from=build /app/publish .

ARG VERSION=dev
ARG ERROR_RATE=0.0
ENV VERSION=$VERSION
ENV ERROR_RATE=$ERROR_RATE

EXPOSE 8080
ENV ASPNETCORE_URLS=http://+:8080
ENTRYPOINT ["dotnet", "CanaryDemo.dll"]

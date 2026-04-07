FROM quay.io/quarkus/ubi-quarkus-native-image:23.1-java21 AS build
WORKDIR /work
COPY . /work
# This is a placeholder to keep the example light-weight.
# In a real repo, you'd include a full Quarkus project and build steps.

FROM public.ecr.aws/amazonlinux/amazonlinux:2023
WORKDIR /app
RUN yum -y install java-21-amazon-corretto-headless && yum clean all
COPY app.jar /app/app.jar
EXPOSE 8080
ENV JAVA_OPTS=""
CMD ["sh","-c","java $JAVA_OPTS -jar /app/app.jar"]

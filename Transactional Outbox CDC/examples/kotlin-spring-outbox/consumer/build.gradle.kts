plugins {
    kotlin("jvm") version "1.9.24"
    application
}

group = "com.example"
version = "0.1.0"

java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }
}

repositories { mavenCentral() }

dependencies {
    implementation("org.apache.kafka:kafka-clients:3.7.1")
    implementation("org.postgresql:postgresql:42.7.4")
    implementation("com.fasterxml.jackson.module:jackson-module-kotlin:2.17.2")
}

application {
    mainClass.set("com.example.consumer.MainKt")
}

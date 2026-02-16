package com.example.consumer

import com.fasterxml.jackson.module.kotlin.jacksonObjectMapper
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.clients.consumer.KafkaConsumer
import org.apache.kafka.common.serialization.StringDeserializer
import java.sql.DriverManager
import java.time.Duration
import java.util.Properties

private val mapper = jacksonObjectMapper()

// Debezium ExtractNewRecordState flattens value to row fields (JSON).
// We expect event_id/event_type/aggregate_id/payload.
data class OutboxRow(
    val event_id: String? = null,
    val event_type: String? = null,
    val aggregate_id: String? = null,
    val payload: Any? = null
)

fun main() {
    val topic = System.getenv().getOrDefault("OUTBOX_TOPIC", "app.public.outbox_events")
    val bootstrap = System.getenv().getOrDefault("KAFKA_BOOTSTRAP", "localhost:9092")
    val groupId = System.getenv().getOrDefault("GROUP_ID", "outbox-consumer")

    val props = Properties().apply {
        put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, bootstrap)
        put(ConsumerConfig.GROUP_ID_CONFIG, groupId)
        put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java.name)
        put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer::class.java.name)
        put(ConsumerConfig.ENABLE_AUTO_COMMIT_CONFIG, "false")
        put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")
        put(ConsumerConfig.MAX_POLL_RECORDS_CONFIG, "50")
    }

    val consumer = KafkaConsumer<String, String>(props)
    consumer.subscribe(listOf(topic))

    val jdbcUrl = System.getenv().getOrDefault("JDBC_URL", "jdbc:postgresql://localhost:5432/appdb")
    val user = System.getenv().getOrDefault("JDBC_USER", "postgres")
    val pass = System.getenv().getOrDefault("JDBC_PASS", "postgres")

    DriverManager.getConnection(jdbcUrl, user, pass).use { conn ->
        conn.createStatement().use { st ->
            st.execute(
                """CREATE TABLE IF NOT EXISTS processed_events(
                      event_id UUID PRIMARY KEY,
                      processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
                    )"""
            )
        }

        println("Consumer started. topic=$topic bootstrap=$bootstrap group=$groupId")

        while (true) {
            val records = consumer.poll(Duration.ofMillis(500))
            if (records.isEmpty) continue

            var processed = 0
            for (rec in records) {
                try {
                    val row = mapper.readValue(rec.value(), OutboxRow::class.java)
                    val eventId = row.event_id ?: continue

                    // Idempotency check
                    val already = conn.prepareStatement("SELECT 1 FROM processed_events WHERE event_id=?::uuid").use { ps ->
                        ps.setString(1, eventId)
                        ps.executeQuery().use { rs -> rs.next() }
                    }
                    if (already) continue

                    // Side effect (demo)
                    println("Apply event type=${row.event_type} aggregate_id=${row.aggregate_id} event_id=$eventId payload=${row.payload}")

                    // Mark processed
                    conn.prepareStatement("INSERT INTO processed_events(event_id) VALUES(?::uuid)").use { ps ->
                        ps.setString(1, eventId)
                        ps.executeUpdate()
                    }
                    processed++
                } catch (e: Exception) {
                    System.err.println("Failed record offset=${rec.offset()} err=${e.message}")
                }
            }

            consumer.commitSync()
            if (processed > 0) println("Committed offsets; processed=$processed")
        }
    }
}

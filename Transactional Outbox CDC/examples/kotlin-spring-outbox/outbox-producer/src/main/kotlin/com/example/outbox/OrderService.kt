package com.example.outbox

import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.jdbc.core.JdbcTemplate
import org.springframework.stereotype.Service
import org.springframework.transaction.annotation.Transactional
import java.time.OffsetDateTime
import java.util.UUID

@Service
class OrderService(private val jdbc: JdbcTemplate, private val mapper: ObjectMapper) {

    @Transactional
    fun createOrder(orderId: String, userId: String, amount: Double): Map<String, Any> {
        require(orderId.isNotBlank()) { "orderId required" }
        require(userId.isNotBlank()) { "userId required" }
        require(amount > 0) { "amount must be > 0" }

        // Local transaction: business state change
        jdbc.update(
            "INSERT INTO orders(order_id, user_id, amount, status) VALUES(?,?,?,?)",
            orderId, userId, amount, "CREATED"
        )

        // Local transaction: outbox record (same transaction)
        val eventId = UUID.randomUUID()
        val payload = mapOf(
            "eventVersion" to 1,
            "orderId" to orderId,
            "userId" to userId,
            "amount" to amount,
            "status" to "CREATED",
            "occurredAt" to OffsetDateTime.now().toString()
        )

        val payloadJson = mapper.writeValueAsString(payload)

        jdbc.update(
            "INSERT INTO outbox_events(event_id, event_type, aggregate_type, aggregate_id, payload, trace_id, correlation_id) " +
                "VALUES(?,?,?,?,?::jsonb,?,?)",
            eventId,
            "OrderCreated",
            "Order",
            orderId,
            payloadJson,
            "trace-demo-$eventId",
            "corr-$orderId"
        )

        return mapOf("ok" to true, "orderId" to orderId, "eventId" to eventId.toString())
    }
}

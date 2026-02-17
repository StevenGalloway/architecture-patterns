package com.example.outbox

import org.springframework.http.ResponseEntity
import org.springframework.web.bind.annotation.*

@RestController
@RequestMapping("/orders")
class OrderController(private val svc: OrderService) {

    data class CreateOrderRequest(val orderId: String, val userId: String, val amount: Double)

    @PostMapping
    fun create(@RequestBody req: CreateOrderRequest): ResponseEntity<Any> {
        val result = svc.createOrder(req.orderId, req.userId, req.amount)
        return ResponseEntity.status(201).body(result)
    }
}

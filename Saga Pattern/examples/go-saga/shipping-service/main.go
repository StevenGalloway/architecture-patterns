
package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

type Envelope struct {
	MessageID     string          `json:"message_id"`
	CorrelationID string          `json:"correlation_id"`
	SagaID        string          `json:"saga_id"`
	Type          string          `json:"type"`
	Payload       json.RawMessage `json:"payload"`
	OccurredAt    string          `json:"occurred_at"`
}

func publishJSON(ch *amqp.Channel, exchange, routingKey string, body any) error {
	b, err := json.Marshal(body)
	if err != nil {
		return err
	}
	return ch.PublishWithContext(context.Background(), exchange, routingKey, false, false, amqp.Publishing{
		ContentType:  "application/json",
		Body:         b,
		DeliveryMode: amqp.Persistent,
		Timestamp:    time.Now(),
	})
}

func mustJSON(v any) json.RawMessage {
	b, _ := json.Marshal(v)
	return b
}

func decodeEnvelope(d amqp.Delivery) (Envelope, error) {
	var e Envelope
	err := json.Unmarshal(d.Body, &e)
	return e, err
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339) }

func logf(prefix, format string, args ...any) {
	fmt.Printf("[%s] "+format+"\n", append([]any{prefix}, args...)...)
}

package main

import (
	"encoding/json"
	"os"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const qShipCmd = "shipping.commands"

type OrderRequest struct {
	OrderID string  `json:"order_id"`
	UserID  string  `json:"user_id"`
	Amount  float64 `json:"amount"`
}

var amqpURL = getenv("AMQP_URL", "amqp://guest:guest@localhost:5672/")

func getenv(k, def string) string { v := os.Getenv(k); if v=="" { return def }; return v }

func setup() (*amqp.Connection, *amqp.Channel) {
	conn, err := amqp.Dial(amqpURL)
	if err != nil { panic(err) }
	ch, err := conn.Channel()
	if err != nil { panic(err) }
	_ = ch.ExchangeDeclare("saga.events", "fanout", true, false, false, false, nil)
	_, _ = ch.QueueDeclare(qShipCmd, true, false, false, false, nil)
	return conn, ch
}

func publishEvent(ch *amqp.Channel, typ string, sagaID string, payload any) {
	evt := Envelope{MessageID: newID(), CorrelationID: sagaID, SagaID: sagaID, Type: typ, Payload: mustJSON(payload), OccurredAt: nowISO()}
	_ = publishJSON(ch, "saga.events", "", evt)
}

func main() {
	conn, ch := setup()
	defer conn.Close()
	defer ch.Close()

	msgs, err := ch.Consume(qShipCmd, "", false, false, false, false, nil)
	if err != nil { panic(err) }

	logf("shipping", "listening on %s", qShipCmd)

	for d := range msgs {
		e, err := decodeEnvelope(d)
		if err != nil { _ = d.Nack(false, false); continue }

		var o OrderRequest
		_ = json.Unmarshal(e.Payload, &o)

		switch e.Type {
		case "ArrangeShipping":
			time.Sleep(150 * time.Millisecond)
			// Always succeed in demo; to simulate failure, extend similarly to inventory.
			publishEvent(ch, "ShippingArranged", e.SagaID, map[string]any{"order_id": o.OrderID, "carrier": "demo-carrier"})
			logf("shipping", "arranged saga=%s order=%s", e.SagaID, o.OrderID)

		case "CancelShipping":
			time.Sleep(100 * time.Millisecond)
			publishEvent(ch, "ShippingCancelled", e.SagaID, map[string]any{"order_id": o.OrderID})
			logf("shipping", "cancelled saga=%s order=%s", e.SagaID, o.OrderID)
		}

		_ = d.Ack(false)
	}
}

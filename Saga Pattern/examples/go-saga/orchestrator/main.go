
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
	"log"
	"net/http"
	"os"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	bolt "go.etcd.io/bbolt"
)

const (
	exEvents = "saga.events"

	qOrchEvents = "orchestrator.events"

	qPayCmd = "payment.commands"
	qInvCmd = "inventory.commands"
	qShipCmd = "shipping.commands"
)

type OrderRequest struct {
	OrderID string  `json:"order_id"`
	UserID  string  `json:"user_id"`
	Amount  float64 `json:"amount"`
}

type SagaState string

const (
	StateStarted     SagaState = "STARTED"
	StatePaymentOK   SagaState = "PAYMENT_OK"
	StateInventoryOK SagaState = "INVENTORY_OK"
	StateShippingOK  SagaState = "SHIPPING_OK"
	StateCompleted   SagaState = "COMPLETED"
	StateFailed      SagaState = "FAILED"
	StateCompensating SagaState = "COMPENSATING"
)

type Saga struct {
	SagaID  string    `json:"saga_id"`
	Order   OrderRequest `json:"order"`
	State   SagaState  `json:"state"`
	Updated string     `json:"updated_at"`
	// what steps succeeded (for compensation ordering)
	PaymentAuthorized  bool `json:"payment_authorized"`
	InventoryReserved  bool `json:"inventory_reserved"`
	ShippingArranged   bool `json:"shipping_arranged"`
}

var (
	amqpURL = getenv("AMQP_URL", "amqp://guest:guest@localhost:5672/")
	dbPath  = getenv("SAGA_DB_PATH", "./saga.db")
)

func getenv(k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		return def
	}
	return v
}

func openDB() *bolt.DB {
	db, err := bolt.Open(dbPath, 0600, &bolt.Options{Timeout: 1 * time.Second})
	if err != nil {
		panic(err)
	}
	_ = db.Update(func(tx *bolt.Tx) error {
		_, _ = tx.CreateBucketIfNotExists([]byte("sagas"))
		_, _ = tx.CreateBucketIfNotExists([]byte("processed"))
		return nil
	})
	return db
}

func getSaga(db *bolt.DB, id string) (*Saga, bool) {
	var s Saga
	err := db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket([]byte("sagas"))
		v := b.Get([]byte(id))
		if v == nil {
			return nil
		}
		return json.Unmarshal(v, &s)
	})
	if err != nil {
		return nil, false
	}
	if s.SagaID == "" {
		return nil, false
	}
	return &s, true
}

func putSaga(db *bolt.DB, s *Saga) error {
	s.Updated = nowISO()
	b, _ := json.Marshal(s)
	return db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("sagas")).Put([]byte(s.SagaID), b)
	})
}

func isProcessed(db *bolt.DB, msgID string) bool {
	var ok bool
	_ = db.View(func(tx *bolt.Tx) error {
		v := tx.Bucket([]byte("processed")).Get([]byte(msgID))
		ok = v != nil
		return nil
	})
	return ok
}

func markProcessed(db *bolt.DB, msgID string) {
	_ = db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket([]byte("processed")).Put([]byte(msgID), []byte(nowISO()))
	})
}

func setupRabbit() (*amqp.Connection, *amqp.Channel) {
	conn, err := amqp.Dial(amqpURL)
	if err != nil {
		panic(err)
	}
	ch, err := conn.Channel()
	if err != nil {
		panic(err)
	}

	// Exchange for events
	_ = ch.ExchangeDeclare(exEvents, "fanout", true, false, false, false, nil)

	// Command queues
	_, _ = ch.QueueDeclare(qPayCmd, true, false, false, false, nil)
	_, _ = ch.QueueDeclare(qInvCmd, true, false, false, false, nil)
	_, _ = ch.QueueDeclare(qShipCmd, true, false, false, false, nil)

	// Orchestrator events queue bound to exchange
	q, _ := ch.QueueDeclare(qOrchEvents, true, false, false, false, nil)
	_ = ch.QueueBind(q.Name, "", exEvents, false, nil)

	return conn, ch
}

func main() {
	db := openDB()
	defer db.Close()

	conn, ch := setupRabbit()
	defer conn.Close()
	defer ch.Close()

	// consumer for events
	deliveries, err := ch.Consume(qOrchEvents, "", false, false, false, false, nil)
	if err != nil {
		panic(err)
	}

	go func() {
		for d := range deliveries {
			e, err := decodeEnvelope(d)
			if err != nil {
				_ = d.Nack(false, false)
				continue
			}
			if e.MessageID == "" {
				e.MessageID = d.MessageId
			}
			if e.MessageID != "" && isProcessed(db, e.MessageID) {
				_ = d.Ack(false)
				continue
			}

			handleEvent(db, ch, e)
			if e.MessageID != "" {
				markProcessed(db, e.MessageID)
			}
			_ = d.Ack(false)
		}
	}()

	// HTTP API to start saga
	http.HandleFunc("/orders", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		var req OrderRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		if req.OrderID == "" || req.UserID == "" || req.Amount <= 0 {
			http.Error(w, "order_id, user_id, amount required", 400)
			return
		}

		sagaID := newID()
		s := &Saga{
			SagaID: sagaID,
			Order:  req,
			State:  StateStarted,
			Updated: nowISO(),
		}
		_ = putSaga(db, s)

		// Send first command: AuthorizePayment
		cmd := Envelope{
			MessageID:     newID(),
			CorrelationID: sagaID,
			SagaID:        sagaID,
			Type:          "AuthorizePayment",
			Payload:       mustJSON(req),
			OccurredAt:    nowISO(),
		}
		if err := publishJSON(ch, "", qPayCmd, cmd); err != nil {
			http.Error(w, "failed to publish command", 502)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": true, "saga_id": sagaID, "status": "STARTED",
			"note": "Saga completes asynchronously; query /sagas/{id} in production (not included in demo).",
		})
	})

	http.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	log.Println("Orchestrator listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}

func handleEvent(db *bolt.DB, ch *amqp.Channel, e Envelope) {
	prefix := "orchestrator"
	s, ok := getSaga(db, e.SagaID)
	if !ok {
		logf(prefix, "unknown saga_id=%s event=%s", e.SagaID, e.Type)
		return
	}

	logf(prefix, "saga=%s state=%s event=%s", s.SagaID, s.State, e.Type)

	switch e.Type {
	case "PaymentAuthorized":
		s.PaymentAuthorized = true
		s.State = StatePaymentOK
		_ = putSaga(db, s)

		cmd := Envelope{MessageID: newID(), CorrelationID: s.SagaID, SagaID: s.SagaID, Type: "ReserveInventory", Payload: mustJSON(s.Order), OccurredAt: nowISO()}
		_ = publishJSON(ch, "", qInvCmd, cmd)

	case "PaymentFailed":
		s.State = StateFailed
		_ = putSaga(db, s)

	case "InventoryReserved":
		s.InventoryReserved = true
		s.State = StateInventoryOK
		_ = putSaga(db, s)

		cmd := Envelope{MessageID: newID(), CorrelationID: s.SagaID, SagaID: s.SagaID, Type: "ArrangeShipping", Payload: mustJSON(s.Order), OccurredAt: nowISO()}
		_ = publishJSON(ch, "", qShipCmd, cmd)

	case "InventoryFailed":
		// compensate payment if it succeeded
		s.State = StateCompensating
		_ = putSaga(db, s)
		if s.PaymentAuthorized {
			cmd := Envelope{MessageID: newID(), CorrelationID: s.SagaID, SagaID: s.SagaID, Type: "RefundPayment", Payload: mustJSON(s.Order), OccurredAt: nowISO()}
			_ = publishJSON(ch, "", qPayCmd, cmd)
		}
		s.State = StateFailed
		_ = putSaga(db, s)

	case "ShippingArranged":
		s.ShippingArranged = true
		s.State = StateCompleted
		_ = putSaga(db, s)

	case "ShippingFailed":
		// compensate inventory and payment (reverse order)
		s.State = StateCompensating
		_ = putSaga(db, s)

		if s.InventoryReserved {
			cmd := Envelope{MessageID: newID(), CorrelationID: s.SagaID, SagaID: s.SagaID, Type: "ReleaseInventory", Payload: mustJSON(s.Order), OccurredAt: nowISO()}
			_ = publishJSON(ch, "", qInvCmd, cmd)
		}
		if s.PaymentAuthorized {
			cmd := Envelope{MessageID: newID(), CorrelationID: s.SagaID, SagaID: s.SagaID, Type: "RefundPayment", Payload: mustJSON(s.Order), OccurredAt: nowISO()}
			_ = publishJSON(ch, "", qPayCmd, cmd)
		}
		s.State = StateFailed
		_ = putSaga(db, s)
	}
}

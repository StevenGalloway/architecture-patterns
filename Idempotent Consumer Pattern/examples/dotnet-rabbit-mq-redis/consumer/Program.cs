using System.Text;
using System.Text.Json;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;
using StackExchange.Redis;

var rabbitHost = Environment.GetEnvironmentVariable("RABBIT_HOST") ?? "localhost";
var redisHost = Environment.GetEnvironmentVariable("REDIS_HOST") ?? "localhost:6379";

var redis = await ConnectionMultiplexer.ConnectAsync(redisHost);
var db = redis.GetDatabase();

var factory = new ConnectionFactory { HostName = rabbitHost };
using var connection = factory.CreateConnection();
using var channel = connection.CreateModel();

const string queue = "work.items";
channel.QueueDeclare(queue: queue, durable: true, exclusive: false, autoDelete: false, arguments: null);
channel.BasicQos(prefetchSize: 0, prefetchCount: 10, global: false);

Console.WriteLine($"Consuming from {queue}. Rabbit={rabbitHost} Redis={redisHost}");

var consumer = new EventingBasicConsumer(channel);
consumer.Received += async (_, ea) =>
{
    var body = Encoding.UTF8.GetString(ea.Body.ToArray());

    // Prefer AMQP message-id; fall back to JSON field
    var messageId = ea.BasicProperties?.MessageId;
    if (string.IsNullOrWhiteSpace(messageId))
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("message_id", out var idProp))
                messageId = idProp.GetString();
        }
        catch { /* ignore */ }
    }

    if (string.IsNullOrWhiteSpace(messageId))
    {
        Console.WriteLine("REJECT: missing message_id; route to DLQ in production.");
        channel.BasicNack(ea.DeliveryTag, multiple: false, requeue: false);
        return;
    }

    var key = $"processed:{messageId}";
    var ttlSeconds = int.TryParse(Environment.GetEnvironmentVariable("IDEMPOTENCY_TTL_SECONDS"), out var ttl) ? ttl : 86400;

    // Atomic dedupe: set only if not exists
    var firstTime = await db.StringSetAsync(key, "1", expiry: TimeSpan.FromSeconds(ttlSeconds), when: When.NotExists);

    if (!firstTime)
    {
        Console.WriteLine($"DUPLICATE: message_id={messageId} -> ACK (skip)");
        channel.BasicAck(ea.DeliveryTag, multiple: false);
        return;
    }

    try
    {
        // Simulated side effect (e.g., write to DB, call external API)
        Console.WriteLine($"PROCESS: message_id={messageId} body={body}");
        await Task.Delay(150); // pretend work

        channel.BasicAck(ea.DeliveryTag, multiple: false);
    }
    catch (Exception ex)
    {
        // Optional: clear dedupe key so the message can be retried.
        // Only do this if you're confident the side effect did not partially apply.
        await db.KeyDeleteAsync(key);

        Console.WriteLine($"ERROR: message_id={messageId} err={ex.Message} -> NACK requeue");
        channel.BasicNack(ea.DeliveryTag, multiple: false, requeue: true);
    }
};

channel.BasicConsume(queue: queue, autoAck: false, consumer: consumer);

Console.WriteLine("Press Ctrl+C to stop.");
await Task.Delay(Timeout.Infinite);

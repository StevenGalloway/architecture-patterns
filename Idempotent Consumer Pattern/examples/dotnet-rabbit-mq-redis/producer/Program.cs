using System.Text;
using System.Text.Json;
using RabbitMQ.Client;

var factory = new ConnectionFactory { HostName = Environment.GetEnvironmentVariable("RABBIT_HOST") ?? "localhost" };
using var connection = factory.CreateConnection();
using var channel = connection.CreateModel();

const string queue = "work.items";
channel.QueueDeclare(queue: queue, durable: true, exclusive: false, autoDelete: false, arguments: null);

static byte[] Body(object o) => Encoding.UTF8.GetBytes(JsonSerializer.Serialize(o));

Console.WriteLine("Publishing messages to queue: work.items");

for (int i = 1; i <= 5; i++)
{
    var messageId = Guid.NewGuid().ToString();
    var msg = new
    {
        message_id = messageId,
        type = "WorkItemCreated",
        occurred_at = DateTimeOffset.UtcNow,
        correlation_id = $"corr-{i}",
        payload = new { workItemId = i, priority = "normal" }
    };

    var props = channel.CreateBasicProperties();
    props.MessageId = messageId;
    props.ContentType = "application/json";
    props.DeliveryMode = 2; // persistent

    channel.BasicPublish(exchange: "", routingKey: queue, basicProperties: props, body: Body(msg));
    Console.WriteLine($"Sent message_id={messageId}");

    // Intentionally publish a duplicate for demo (same message_id)
    if (i % 2 == 0)
    {
        channel.BasicPublish(exchange: "", routingKey: queue, basicProperties: props, body: Body(msg));
        Console.WriteLine($"Sent DUPLICATE message_id={messageId}");
    }
}

Console.WriteLine("Done.");

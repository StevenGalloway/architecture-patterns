# Minimal region stack: VPC + ECS/Fargate + ALB (simplified)
# For real implementations, add NAT gateways, private subnets, security hardening, autoscaling, etc.

resource "aws_vpc" "this" {
  cidr_block = "10.0.0.0/16"
  tags = { Name = "mr-${var.region_name}" }
}

resource "aws_subnet" "a" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.0.1.0/24"
  availability_zone = "${var.region_name}a"
}

resource "aws_subnet" "b" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = "10.0.2.0/24"
  availability_zone = "${var.region_name}b"
}

resource "aws_security_group" "alb" {
  name   = "mr-alb-${var.region_name}"
  vpc_id = aws_vpc.this.id
  ingress { from_port = 80 to_port = 80 protocol = "tcp" cidr_blocks = ["0.0.0.0/0"] }
  egress  { from_port = 0  to_port = 0  protocol = "-1"  cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_lb" "this" {
  name               = "mr-${replace(var.region_name, "-", "")}-alb"
  load_balancer_type = "application"
  subnets            = [aws_subnet.a.id, aws_subnet.b.id]
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "tg" {
  name     = "mr-${replace(var.region_name, "-", "")}-tg"
  port     = 80
  protocol = "HTTP"
  vpc_id   = aws_vpc.this.id
  health_check {
    path = "/"
    matcher = "200-399"
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.this.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.tg.arn
  }
}

resource "aws_ecs_cluster" "this" {
  name = "mr-${var.region_name}"
}

resource "aws_iam_role" "task_exec" {
  name = "mr-task-exec-${replace(var.region_name, "-", "")}"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Effect = "Allow",
      Principal = { Service = "ecs-tasks.amazonaws.com" },
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_exec_policy" {
  role       = aws_iam_role.task_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "app" {
  family                   = "mr-app-${var.region_name}"
  cpu                      = "256"
  memory                   = "512"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_exec.arn

  container_definitions = jsonencode([{
    name  = "app"
    image = var.image
    portMappings = [{ containerPort = 80, hostPort = 80, protocol = "tcp" }]
    environment = [{ name = "REGION", value = var.region_name }]
  }])
}

resource "aws_security_group" "svc" {
  name   = "mr-svc-${var.region_name}"
  vpc_id = aws_vpc.this.id
  ingress { from_port = 80 to_port = 80 protocol = "tcp" security_groups = [aws_security_group.alb.id] }
  egress  { from_port = 0  to_port = 0  protocol = "-1" cidr_blocks = ["0.0.0.0/0"] }
}

resource "aws_ecs_service" "app" {
  name            = "mr-app"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [aws_subnet.a.id, aws_subnet.b.id]
    security_groups = [aws_security_group.svc.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.tg.arn
    container_name   = "app"
    container_port   = 80
  }

  depends_on = [aws_lb_listener.http]
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "alb_zone_id"  { value = aws_lb.this.zone_id }

# DynamoDB Global Table (simplified)
# In production: add encryption, PITR, autoscaling, and strict IAM.
resource "aws_dynamodb_table" "r1" {
  provider     = aws.r1
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute { name = "pk" type = "S" }
}

resource "aws_dynamodb_table" "r2" {
  provider     = aws.r2
  name         = var.table_name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute { name = "pk" type = "S" }
}

resource "aws_dynamodb_global_table" "gt" {
  name = var.table_name

  replica { region_name = aws_dynamodb_table.r1.provider_region }
  replica { region_name = aws_dynamodb_table.r2.provider_region }
}

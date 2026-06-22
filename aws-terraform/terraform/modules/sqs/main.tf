# ─── Dead Letter Queue ────────────────────────────────────────────────────
resource "aws_sqs_queue" "order_processing_dlq" {
  name                       = "${var.project_name}-order-processing-dlq"
  message_retention_seconds  = 1209600 # 14 days
  visibility_timeout_seconds = 30

  tags = { Name = "${var.project_name}-order-processing-dlq" }
}

# ─── Main Order Processing Queue ──────────────────────────────────────────
resource "aws_sqs_queue" "order_processing" {
  name                       = "${var.project_name}-order-processing"
  message_retention_seconds  = 86400 # 1 day
  visibility_timeout_seconds = 30
  receive_wait_time_seconds  = 20 # Long polling

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.order_processing_dlq.arn
    maxReceiveCount     = 3
  })

  tags = { Name = "${var.project_name}-order-processing" }
}

resource "aws_sqs_queue_policy" "order_processing" {
  queue_url = aws_sqs_queue.order_processing.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = var.additional_role_arns }
      Action    = ["sqs:SendMessage", "sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:GetQueueUrl", "sqs:ChangeMessageVisibility"]
      Resource  = aws_sqs_queue.order_processing.arn
    }]
  })
}

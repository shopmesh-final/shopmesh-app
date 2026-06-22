output "order_queue_url" { value = aws_sqs_queue.order_processing.url }
output "order_queue_arn" { value = aws_sqs_queue.order_processing.arn }
output "order_dlq_url" { value = aws_sqs_queue.order_processing_dlq.url }
output "order_dlq_arn" { value = aws_sqs_queue.order_processing_dlq.arn }

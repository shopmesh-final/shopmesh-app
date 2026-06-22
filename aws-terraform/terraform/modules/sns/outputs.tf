output "alerts_topic_arn" { value = aws_sns_topic.alerts.arn }
output "alerts_topic_name" { value = aws_sns_topic.alerts.name }
output "orders_topic_arn" { value = aws_sns_topic.orders.arn }
output "orders_topic_name" { value = aws_sns_topic.orders.name }

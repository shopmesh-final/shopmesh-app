output "daily_order_summary_rule_arn" { value = aws_cloudwatch_event_rule.daily_order_summary.arn }
output "hourly_health_check_rule_arn" { value = aws_cloudwatch_event_rule.hourly_health_check.arn }
output "weekly_cleanup_rule_arn" { value = aws_cloudwatch_event_rule.weekly_cleanup.arn }

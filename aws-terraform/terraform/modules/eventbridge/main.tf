# ─── Daily Order Summary Rule ─────────────────────────────────────────────
resource "aws_cloudwatch_event_rule" "daily_order_summary" {
  name                = "${var.project_name}-daily-order-summary"
  description         = "Triggers daily order summary generation"
  schedule_expression = "cron(0 8 * * ? *)" # 8:00 AM UTC daily

  tags = { Name = "${var.project_name}-daily-order-summary" }
}

resource "aws_cloudwatch_event_target" "daily_order_summary_sns" {
  rule      = aws_cloudwatch_event_rule.daily_order_summary.name
  target_id = "SendToSNS"
  arn       = var.orders_topic_arn
  role_arn  = var.eventbridge_role_arn

  input = jsonencode({
    event_type  = "daily_order_summary"
    scheduled   = true
    description = "Trigger daily order summary report"
  })
}

# ─── Hourly Health Check Rule ─────────────────────────────────────────────
resource "aws_cloudwatch_event_rule" "hourly_health_check" {
  name                = "${var.project_name}-hourly-health-check"
  description         = "Triggers hourly infrastructure health check"
  schedule_expression = "rate(1 hour)"

  tags = { Name = "${var.project_name}-hourly-health-check" }
}

resource "aws_cloudwatch_event_target" "hourly_health_check_sns" {
  rule      = aws_cloudwatch_event_rule.hourly_health_check.name
  target_id = "SendToSNS"
  arn       = var.alerts_topic_arn
  role_arn  = var.eventbridge_role_arn

  input = jsonencode({
    event_type  = "health_check"
    scheduled   = true
    description = "Hourly infrastructure health check"
  })
}

# ─── Weekly Cleanup Rule ──────────────────────────────────────────────────
resource "aws_cloudwatch_event_rule" "weekly_cleanup" {
  name                = "${var.project_name}-weekly-cleanup"
  description         = "Weekly maintenance and cleanup tasks"
  schedule_expression = "cron(0 2 ? * SUN *)" # 2:00 AM UTC every Sunday

  tags = { Name = "${var.project_name}-weekly-cleanup" }
}

resource "aws_cloudwatch_event_target" "weekly_cleanup_sns" {
  rule      = aws_cloudwatch_event_rule.weekly_cleanup.name
  target_id = "SendToSNS"
  arn       = var.alerts_topic_arn
  role_arn  = var.eventbridge_role_arn

  input = jsonencode({
    event_type  = "weekly_cleanup"
    scheduled   = true
    description = "Weekly cleanup trigger"
  })
}

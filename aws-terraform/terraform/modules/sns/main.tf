# ─── shopmesh-alerts topic ────────────────────────────────────────────────
resource "aws_sns_topic" "alerts" {
  name = "${var.project_name}-alerts"

  tags = { Name = "${var.project_name}-alerts" }
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email != "" ? 1 : 0
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# ─── shopmesh-orders topic ────────────────────────────────────────────────
resource "aws_sns_topic" "orders" {
  name = "${var.project_name}-orders"

  tags = { Name = "${var.project_name}-orders" }
}

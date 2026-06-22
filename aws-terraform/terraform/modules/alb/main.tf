# ─── External ALB (public, facing internet) ───────────────────────────────
resource "aws_lb" "external" {
  name               = "${var.project_name}-external-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [var.external_alb_sg_id]
  subnets            = var.public_subnet_ids

  access_logs {
    bucket  = var.alb_logs_bucket
    prefix  = "external-alb"
    enabled = true
  }

  tags = { Name = "${var.project_name}-external-alb" }
}

# Frontend TG — ip type so EKS TargetGroupBinding can register pod IPs directly
resource "aws_lb_target_group" "frontend" {
  name        = "${var.project_name}-frontend-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  health_check {
    enabled             = true
    path                = "/health"
    protocol            = "HTTP"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 5
    timeout             = 10
    interval            = 30
    matcher             = "200"
  }

  tags = { Name = "${var.project_name}-frontend-tg" }
}

resource "aws_lb_listener" "external_http" {
  load_balancer_arn = aws_lb.external.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

resource "aws_lb_listener" "external_https" {
  load_balancer_arn = aws_lb.external.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.frontend.arn
  }
}

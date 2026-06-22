output "external_alb_dns_name" { value = aws_lb.external.dns_name }
output "external_alb_arn" { value = aws_lb.external.arn }
output "external_alb_arn_suffix" { value = aws_lb.external.arn_suffix }
output "frontend_target_group_arn" { value = aws_lb_target_group.frontend.arn }
output "external_https_listener_arn" { value = aws_lb_listener.external_https.arn }

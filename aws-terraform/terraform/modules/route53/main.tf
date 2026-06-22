# ─── Hosted Zone ──────────────────────────────────────────────────────────
resource "aws_route53_zone" "main" {
  name    = var.domain_name
  comment = "Managed by Terraform — ${var.project_name}"

  tags = { Name = "${var.project_name}-zone" }
}

# ─── ACM DNS Validation Records ───────────────────────────────────────────
# Both the ALB cert and the CloudFront cert (us-east-1) validate against the
# same domain, so they produce the same CNAME record.  Keying by domain_name
# deduplicates them — last value wins, but they are identical.
resource "aws_route53_record" "acm_validation" {
  for_each = {
    for dvo in var.cert_validation_options : dvo.domain_name => {
      name   = dvo.resource_record_name
      record = dvo.resource_record_value
      type   = dvo.resource_record_type
    }
  }

  allow_overwrite = true
  name            = each.value.name
  records         = [each.value.record]
  ttl             = 60
  type            = each.value.type
  zone_id         = aws_route53_zone.main.zone_id
}

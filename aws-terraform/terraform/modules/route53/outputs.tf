output "zone_id" {
  description = "Route53 hosted zone ID"
  value       = aws_route53_zone.main.zone_id
}

output "name_servers" {
  description = "NS records to configure at your domain registrar"
  value       = aws_route53_zone.main.name_servers
}

output "acm_validation_record_fqdns" {
  description = "FQDNs of the ACM CNAME validation records — passed to aws_acm_certificate_validation"
  value       = [for r in aws_route53_record.acm_validation : r.fqdn]
}

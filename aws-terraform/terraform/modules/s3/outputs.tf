output "product_images_bucket_name" { value = aws_s3_bucket.product_images.bucket }
output "product_images_bucket_arn" { value = aws_s3_bucket.product_images.arn }
output "alb_logs_bucket_name" { value = aws_s3_bucket.alb_logs.bucket }
output "alb_logs_bucket_arn" { value = aws_s3_bucket.alb_logs.arn }
output "cloudfront_logs_bucket_name" { value = aws_s3_bucket.cloudfront_logs.bucket }
output "cloudfront_logs_bucket_arn" { value = aws_s3_bucket.cloudfront_logs.arn }

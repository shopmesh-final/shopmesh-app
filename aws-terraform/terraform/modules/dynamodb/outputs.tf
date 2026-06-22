output "users_table_name" { value = aws_dynamodb_table.users.name }
output "users_table_arn" { value = aws_dynamodb_table.users.arn }
output "products_table_name" { value = aws_dynamodb_table.products.name }
output "products_table_arn" { value = aws_dynamodb_table.products.arn }
output "orders_table_name" { value = aws_dynamodb_table.orders.name }
output "orders_table_arn" { value = aws_dynamodb_table.orders.arn }

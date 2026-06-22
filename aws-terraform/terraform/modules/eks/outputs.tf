output "cluster_name" { value = aws_eks_cluster.main.name }
output "cluster_endpoint" { value = aws_eks_cluster.main.endpoint }
output "cluster_ca_certificate" { value = aws_eks_cluster.main.certificate_authority[0].data }
output "cluster_oidc_issuer_url" { value = aws_eks_cluster.main.identity[0].oidc[0].issuer }
output "oidc_provider_arn" { value = aws_iam_openid_connect_provider.eks.arn }
output "node_group_role_arn" { value = aws_iam_role.node_group.arn }
output "node_group_role_name" { value = aws_iam_role.node_group.name }

# ─── EKS Cluster IAM Role ─────────────────────────────────────────────────
resource "aws_iam_role" "eks_cluster" {
  name = "${var.project_name}-eks-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "eks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.project_name}-eks-cluster-role" }
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  role       = aws_iam_role.eks_cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

# ─── EKS Cluster ──────────────────────────────────────────────────────────
resource "aws_eks_cluster" "main" {
  name     = "${var.project_name}-prod"
  version  = var.cluster_version
  role_arn = aws_iam_role.eks_cluster.arn

  vpc_config {
    subnet_ids              = concat(var.private_subnet_ids, var.public_subnet_ids)
    endpoint_public_access  = true
    endpoint_private_access = true
    security_group_ids      = []
  }

  enabled_cluster_log_types = ["api", "audit", "authenticator", "controllerManager", "scheduler"]

  tags = { Name = "${var.project_name}-prod" }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster_policy]
}

# ─── Node Group IAM Role ──────────────────────────────────────────────────
resource "aws_iam_role" "node_group" {
  name = "${var.project_name}-eks-node-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = { Name = "${var.project_name}-eks-node-role" }
}

resource "aws_iam_role_policy_attachment" "node_worker_policy" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
}

resource "aws_iam_role_policy_attachment" "node_cni_policy" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
}

resource "aws_iam_role_policy_attachment" "node_ecr_policy" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
}

resource "aws_iam_role_policy_attachment" "node_ssm_policy" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy_attachment" "node_cloudwatch_policy" {
  role       = aws_iam_role.node_group.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ─── EKS Node Launch Template ─────────────────────────────────────────────
# Sets http_put_response_hop_limit=2 so pods (2 hops from IMDS) can reach
# EC2 metadata. Without this, AWS LBC times out on VPC auto-discovery.
resource "aws_launch_template" "eks_nodes" {
  name_prefix = "${var.project_name}-eks-node-"

  metadata_options {
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
    http_tokens                 = "optional"
  }

  # disk_size cannot be set on the node group when launch_template is used
  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = var.node_disk_size
      volume_type           = "gp3"
      delete_on_termination = true
    }
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${var.project_name}-eks-node"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

# ─── Managed Node Group ───────────────────────────────────────────────────
resource "aws_eks_node_group" "main" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "${var.project_name}-prod-ng"
  node_role_arn   = aws_iam_role.node_group.arn
  subnet_ids      = var.private_subnet_ids # worker nodes in private subnets only

  instance_types = var.node_instance_type
  # disk_size set in launch_template block_device_mappings instead

  launch_template {
    id      = aws_launch_template.eks_nodes.id
    version = aws_launch_template.eks_nodes.latest_version
  }

  scaling_config {
    min_size     = var.node_min_size
    desired_size = var.node_desired_size
    max_size     = var.node_max_size
  }

  update_config {
    max_unavailable = 1
  }

  tags = { Name = "${var.project_name}-prod-ng" }

  depends_on = [
    aws_iam_role_policy_attachment.node_worker_policy,
    aws_iam_role_policy_attachment.node_cni_policy,
    aws_iam_role_policy_attachment.node_ecr_policy,
    aws_iam_role_policy_attachment.node_ssm_policy,
    aws_iam_role_policy_attachment.node_cloudwatch_policy,
  ]
}

# ─── OIDC Provider (required for IRSA) ───────────────────────────────────
data "tls_certificate" "eks_oidc" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks_oidc.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer

  tags = { Name = "${var.project_name}-eks-oidc" }
}

# ─── Subnet Tags (required for ALB/NLB discovery) ────────────────────────
resource "aws_ec2_tag" "private_subnet_cluster" {
  count       = length(var.private_subnet_ids)
  resource_id = var.private_subnet_ids[count.index]
  key         = "kubernetes.io/cluster/${aws_eks_cluster.main.name}"
  value       = "shared"
}

resource "aws_ec2_tag" "private_subnet_elb" {
  count       = length(var.private_subnet_ids)
  resource_id = var.private_subnet_ids[count.index]
  key         = "kubernetes.io/role/internal-elb"
  value       = "1"
}

resource "aws_ec2_tag" "public_subnet_cluster" {
  count       = length(var.public_subnet_ids)
  resource_id = var.public_subnet_ids[count.index]
  key         = "kubernetes.io/cluster/${aws_eks_cluster.main.name}"
  value       = "shared"
}

resource "aws_ec2_tag" "public_subnet_elb" {
  count       = length(var.public_subnet_ids)
  resource_id = var.public_subnet_ids[count.index]
  key         = "kubernetes.io/role/elb"
  value       = "1"
}

# ─── EKS Managed Add-ons ─────────────────────────────────────────────────
resource "aws_eks_addon" "vpc_cni" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "vpc-cni"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}

resource "aws_eks_addon" "coredns" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "coredns"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}

resource "aws_eks_addon" "kube_proxy" {
  cluster_name                = aws_eks_cluster.main.name
  addon_name                  = "kube-proxy"
  resolve_conflicts_on_create = "OVERWRITE"
  resolve_conflicts_on_update = "OVERWRITE"

  depends_on = [aws_eks_node_group.main]
}


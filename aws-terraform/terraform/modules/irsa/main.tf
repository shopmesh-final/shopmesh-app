locals {
  oidc_issuer = replace(var.oidc_issuer_url, "https://", "")

  # Bedrock model ARN pattern covering nova-lite and cross-region inference profiles
  bedrock_model_arns = [
    "arn:aws:bedrock:${var.aws_region}::foundation-model/amazon.nova-lite-v1:0",
    "arn:aws:bedrock:${var.aws_region}:${var.account_id}:inference-profile/us.amazon.nova-lite-v1:0",
    "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0",
    "arn:aws:bedrock:us-east-1:${var.account_id}:inference-profile/us.amazon.nova-lite-v1:0",
  ]
}

# ─── Helper: produce the OIDC trust policy for a given SA ────────────────
data "aws_iam_policy_document" "irsa_trust" {
  for_each = {
    auth-service         = "system:serviceaccount:production:auth-service"
    product-service      = "system:serviceaccount:production:product-service"
    order-service        = "system:serviceaccount:production:order-service"
    analytics-service    = "system:serviceaccount:production:analytics-service"
    ai-assistant-service = "system:serviceaccount:production:ai-assistant-service"
    external-secrets     = "system:serviceaccount:external-secrets:external-secrets-sa"
    aws-lb-controller    = "system:serviceaccount:kube-system:aws-load-balancer-controller"
    cloudwatch-agent     = "system:serviceaccount:amazon-cloudwatch:cloudwatch-agent"
    fluent-bit           = "system:serviceaccount:amazon-cloudwatch:fluent-bit"
    ebs-csi-controller   = "system:serviceaccount:kube-system:ebs-csi-controller-sa"
  }

  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = [var.oidc_provider_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:sub"
      values   = [each.value]
    }

    condition {
      test     = "StringEquals"
      variable = "${local.oidc_issuer}:aud"
      values   = ["sts.amazonaws.com"]
    }
  }
}

# ─── auth-service ─────────────────────────────────────────────────────────
resource "aws_iam_role" "auth_service" {
  name               = "${var.project_name}-irsa-auth-service"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["auth-service"].json
  tags               = { Name = "${var.project_name}-irsa-auth-service" }
}

resource "aws_iam_role_policy" "auth_service" {
  name = "auth-service-policy"
  role = aws_iam_role.auth_service.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${var.account_id}:secret:${var.project_name}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = [
          var.dynamodb_users_table_arn,
          "${var.dynamodb_users_table_arn}/index/*",
        ]
      },
    ]
  })
}

# ─── product-service ──────────────────────────────────────────────────────
resource "aws_iam_role" "product_service" {
  name               = "${var.project_name}-irsa-product-service"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["product-service"].json
  tags               = { Name = "${var.project_name}-irsa-product-service" }
}

resource "aws_iam_role_policy" "product_service" {
  name = "product-service-policy"
  role = aws_iam_role.product_service.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"]
        Resource = "arn:aws:secretsmanager:${var.aws_region}:${var.account_id}:secret:${var.project_name}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = [
          var.dynamodb_products_table_arn,
          "${var.dynamodb_products_table_arn}/index/*",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
        Resource = "${var.s3_product_images_bucket_arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = var.s3_product_images_bucket_arn
      },
      {
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = [var.sns_orders_topic_arn, var.sns_alerts_topic_arn]
      },
    ]
  })
}

# ─── order-service ────────────────────────────────────────────────────────
resource "aws_iam_role" "order_service" {
  name               = "${var.project_name}-irsa-order-service"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["order-service"].json
  tags               = { Name = "${var.project_name}-irsa-order-service" }
}

resource "aws_iam_role_policy" "order_service" {
  name = "order-service-policy"
  role = aws_iam_role.order_service.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
          "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:Scan",
          "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = [
          var.dynamodb_orders_table_arn,
          "${var.dynamodb_orders_table_arn}/index/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "sqs:SendMessage", "sqs:ReceiveMessage",
          "sqs:DeleteMessage", "sqs:GetQueueAttributes",
          "sqs:GetQueueUrl", "sqs:ChangeMessageVisibility",
        ]
        Resource = var.sqs_order_queue_arn
      },
      {
        Effect   = "Allow"
        Action   = ["sns:Publish"]
        Resource = [var.sns_orders_topic_arn, var.sns_alerts_topic_arn]
      },
    ]
  })
}

# ─── analytics-service ────────────────────────────────────────────────────
resource "aws_iam_role" "analytics_service" {
  name               = "${var.project_name}-irsa-analytics-service"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["analytics-service"].json
  tags               = { Name = "${var.project_name}-irsa-analytics-service" }
}

resource "aws_iam_role_policy" "analytics_service" {
  name = "analytics-service-policy"
  role = aws_iam_role.analytics_service.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan",
          "dynamodb:BatchGetItem", "dynamodb:DescribeTable",
        ]
        Resource = [
          var.dynamodb_orders_table_arn,
          "${var.dynamodb_orders_table_arn}/index/*",
          var.dynamodb_users_table_arn,
          "${var.dynamodb_users_table_arn}/index/*",
          var.dynamodb_products_table_arn,
          "${var.dynamodb_products_table_arn}/index/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
          "bedrock:Converse",
          "bedrock:ConverseStream",
        ]
        Resource = local.bedrock_model_arns
      },
    ]
  })
}

# ─── ai-assistant-service ─────────────────────────────────────────────────
resource "aws_iam_role" "ai_assistant_service" {
  name               = "${var.project_name}-irsa-ai-assistant-service"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["ai-assistant-service"].json
  tags               = { Name = "${var.project_name}-irsa-ai-assistant-service" }
}

resource "aws_iam_role_policy" "ai_assistant_service" {
  name = "ai-assistant-service-policy"
  role = aws_iam_role.ai_assistant_service.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "bedrock:Converse",
          "bedrock:ConverseStream",
          "bedrock:InvokeModel",
          "bedrock:InvokeModelWithResponseStream",
        ]
        Resource = local.bedrock_model_arns
      },
    ]
  })
}

# ─── External Secrets Operator ────────────────────────────────────────────
resource "aws_iam_role" "external_secrets" {
  name               = "${var.project_name}-irsa-external-secrets"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["external-secrets"].json
  tags               = { Name = "${var.project_name}-irsa-external-secrets" }
}

resource "aws_iam_role_policy" "external_secrets" {
  name = "external-secrets-policy"
  role = aws_iam_role.external_secrets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue",
        "secretsmanager:DescribeSecret",
        "secretsmanager:ListSecrets",
        "secretsmanager:ListSecretVersionIds",
      ]
      Resource = "arn:aws:secretsmanager:${var.aws_region}:${var.account_id}:secret:${var.project_name}/*"
    }]
  })
}

# ─── AWS Load Balancer Controller ─────────────────────────────────────────
resource "aws_iam_role" "aws_lb_controller" {
  name               = "${var.project_name}-irsa-aws-lb-controller"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["aws-lb-controller"].json
  tags               = { Name = "${var.project_name}-irsa-aws-lb-controller" }
}

resource "aws_iam_role_policy" "aws_lb_controller" {
  name = "aws-lb-controller-policy"
  role = aws_iam_role.aws_lb_controller.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iam:CreateServiceLinkedRole"]
        Resource = "*"
        Condition = {
          StringEquals = { "iam:AWSServiceName" = "elasticloadbalancing.amazonaws.com" }
        }
      },
      {
        Effect    = "Allow"
        Action    = ["eks:DescribeCluster"]
        Resource  = "arn:aws:eks:*:*:cluster/*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:DescribeAccountAttributes", "ec2:DescribeAddresses",
          "ec2:DescribeAvailabilityZones", "ec2:DescribeInternetGateways",
          "ec2:DescribeVpcs", "ec2:DescribeVpcPeeringConnections",
          "ec2:DescribeSubnets", "ec2:DescribeSecurityGroups",
          "ec2:DescribeInstances", "ec2:DescribeNetworkInterfaces",
          "ec2:DescribeTags", "ec2:GetCoipPoolUsage",
          "ec2:DescribeCoipPools", "elasticloadbalancing:DescribeLoadBalancers",
          "elasticloadbalancing:DescribeLoadBalancerAttributes",
          "elasticloadbalancing:DescribeListeners",
          "elasticloadbalancing:DescribeListenerCertificates",
          "elasticloadbalancing:DescribeSSLPolicies",
          "elasticloadbalancing:DescribeRules",
          "elasticloadbalancing:DescribeTargetGroups",
          "elasticloadbalancing:DescribeTargetGroupAttributes",
          "elasticloadbalancing:DescribeTargetHealth",
          "elasticloadbalancing:DescribeTags",
          "elasticloadbalancing:DescribeTrustStores",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "cognito-idp:DescribeUserPoolClient",
          "acm:ListCertificates", "acm:DescribeCertificate",
          "iam:ListServerCertificates", "iam:GetServerCertificate",
          "waf-regional:GetWebACL", "waf-regional:GetWebACLForResource",
          "waf-regional:AssociateWebACL", "waf-regional:DisassociateWebACL",
          "wafv2:GetWebACL", "wafv2:GetWebACLForResource",
          "wafv2:AssociateWebACL", "wafv2:DisassociateWebACL",
          "shield:GetSubscriptionState", "shield:DescribeProtection",
          "shield:CreateProtection", "shield:DeleteProtection",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress",
          "ec2:CreateSecurityGroup",
        ]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateTags"]
        Resource = "arn:aws:ec2:*:*:security-group/*"
        Condition = {
          StringEquals = { "ec2:CreateAction" = "CreateSecurityGroup" }
          "Null"       = { "aws:RequestTag/elbv2.k8s.aws/cluster" = "false" }
        }
      },
      {
        Effect   = "Allow"
        Action   = ["ec2:CreateTags", "ec2:DeleteTags"]
        Resource = "arn:aws:ec2:*:*:security-group/*"
        Condition = {
          "Null" = {
            "aws:RequestTag/elbv2.k8s.aws/cluster"  = "true"
            "aws:ResourceTag/elbv2.k8s.aws/cluster" = "false"
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "ec2:AuthorizeSecurityGroupIngress", "ec2:RevokeSecurityGroupIngress",
          "ec2:DeleteSecurityGroup",
        ]
        Resource = "*"
        Condition = {
          "Null" = { "aws:ResourceTag/elbv2.k8s.aws/cluster" = "false" }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:CreateLoadBalancer",
          "elasticloadbalancing:CreateTargetGroup",
        ]
        Resource = "*"
        Condition = {
          "Null" = { "aws:RequestTag/elbv2.k8s.aws/cluster" = "false" }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:CreateListener",
          "elasticloadbalancing:DeleteListener",
          "elasticloadbalancing:CreateRule",
          "elasticloadbalancing:DeleteRule",
        ]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:AddTags",
          "elasticloadbalancing:RemoveTags",
        ]
        Resource = [
          "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
        ]
        Condition = {
          "Null" = {
            "aws:RequestTag/elbv2.k8s.aws/cluster"  = "true"
            "aws:ResourceTag/elbv2.k8s.aws/cluster" = "false"
          }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:AddTags",
          "elasticloadbalancing:RemoveTags",
        ]
        Resource = [
          "arn:aws:elasticloadbalancing:*:*:listener/net/*/*/*",
          "arn:aws:elasticloadbalancing:*:*:listener/app/*/*/*",
          "arn:aws:elasticloadbalancing:*:*:listener-rule/net/*/*/*",
          "arn:aws:elasticloadbalancing:*:*:listener-rule/app/*/*/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:ModifyLoadBalancerAttributes",
          "elasticloadbalancing:SetIpAddressType",
          "elasticloadbalancing:SetSecurityGroups",
          "elasticloadbalancing:SetSubnets",
          "elasticloadbalancing:DeleteLoadBalancer",
          "elasticloadbalancing:ModifyTargetGroup",
          "elasticloadbalancing:ModifyTargetGroupAttributes",
          "elasticloadbalancing:DeleteTargetGroup",
        ]
        Resource = "*"
        Condition = {
          "Null" = { "aws:ResourceTag/elbv2.k8s.aws/cluster" = "false" }
        }
      },
      {
        Effect = "Allow"
        Action = ["elasticloadbalancing:AddTags"]
        Resource = [
          "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/net/*/*",
          "arn:aws:elasticloadbalancing:*:*:loadbalancer/app/*/*",
        ]
        Condition = {
          StringEquals = { "elasticloadbalancing:CreateAction" = ["CreateTargetGroup", "CreateLoadBalancer"] }
          "Null"       = { "aws:RequestTag/elbv2.k8s.aws/cluster" = "false" }
        }
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:RegisterTargets",
          "elasticloadbalancing:DeregisterTargets",
        ]
        Resource = "arn:aws:elasticloadbalancing:*:*:targetgroup/*/*"
      },
      {
        Effect = "Allow"
        Action = [
          "elasticloadbalancing:SetWebAcl",
          "elasticloadbalancing:ModifyListener",
          "elasticloadbalancing:AddListenerCertificates",
          "elasticloadbalancing:RemoveListenerCertificates",
          "elasticloadbalancing:ModifyRule",
        ]
        Resource = "*"
      },
    ]
  })
}

# ─── CloudWatch Agent (for Container Insights add-on) ────────────────────
resource "aws_iam_role" "cloudwatch_agent" {
  name               = "${var.project_name}-irsa-cloudwatch-agent"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["cloudwatch-agent"].json
  tags               = { Name = "${var.project_name}-irsa-cloudwatch-agent" }
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent_policy" {
  role       = aws_iam_role.cloudwatch_agent.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

resource "aws_iam_role_policy_attachment" "cloudwatch_agent_xray" {
  role       = aws_iam_role.cloudwatch_agent.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# ─── Fluent Bit (log forwarding DaemonSet) ───────────────────────────────
# Separate role from cloudwatch-agent because the SA name differs.
# The aws-for-fluent-bit chart creates SA named after its release ("fluent-bit").
resource "aws_iam_role" "fluent_bit" {
  name               = "${var.project_name}-irsa-fluent-bit"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["fluent-bit"].json
  tags               = { Name = "${var.project_name}-irsa-fluent-bit" }
}

resource "aws_iam_role_policy_attachment" "fluent_bit_cloudwatch" {
  role       = aws_iam_role.fluent_bit.name
  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"
}

# ─── EBS CSI Driver Controller ────────────────────────────────────────────
# Declared here, but the aws_eks_addon resource lives in root main.tf to avoid
# the circular dependency between module.eks (OIDC provider) and module.irsa.
resource "aws_iam_role" "ebs_csi" {
  name               = "${var.project_name}-irsa-ebs-csi"
  assume_role_policy = data.aws_iam_policy_document.irsa_trust["ebs-csi-controller"].json
  tags               = { Name = "${var.project_name}-irsa-ebs-csi" }
}

resource "aws_iam_role_policy_attachment" "ebs_csi_policy" {
  role       = aws_iam_role.ebs_csi.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicy"
}

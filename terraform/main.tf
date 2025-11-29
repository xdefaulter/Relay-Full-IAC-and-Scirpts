terraform {
  required_version = ">= 1.5.7"
  
  # Uncomment after creating S3 bucket and DynamoDB table for state locking
  # backend "s3" {
  #   bucket         = "relay-terraform-state"
  #   key            = "relay-cluster/terraform.tfstate"
  #   region         = "ca-west-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-state-lock"
  # }
  
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true
  
  tags = {
    Name        = "relay-vpc"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.main.id
  cidr_block              = "10.0.1.0/24"
  map_public_ip_on_launch = true
  
  tags = {
    Name        = "relay-public-subnet"
    Environment = var.environment
    ManagedBy   = "terraform"
  }
}

resource "aws_internet_gateway" "igw" {
  vpc_id = aws_vpc.main.id
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.igw.id
  }
}

resource "aws_route_table_association" "public_assoc" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

resource "aws_security_group" "manager_sg" {
  name        = "manager-sg"
  description = "Manager security group"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTP"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "HTTPS"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  ingress {
    description = "WS/HTTP for agents"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = [aws_vpc.main.cidr_block]
  }

  # SSH access - restrict to admin IPs only
  dynamic "ingress" {
    for_each = var.admin_ssh_cidr != "" ? [1] : []
    content {
      description = "SSH from admin"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [var.admin_ssh_cidr]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "worker_sg" {
  name        = "worker-sg"
  description = "Worker security group"
  vpc_id      = aws_vpc.main.id

  # SSH access - restrict to admin IPs only
  # If admin_ssh_cidr is not set, SSH access is disabled
  dynamic "ingress" {
    for_each = var.admin_ssh_cidr != "" ? [1] : []
    content {
      description = "SSH from admin"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [var.admin_ssh_cidr]
    }
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*"]
  }
}



# IAM Role for EC2 Instances to access SSM
resource "aws_iam_role" "ec2_ssm_role" {
  name = "relay_ec2_ssm_role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      }
    ]
  })
}

resource "aws_iam_role_policy" "ssm_access" {
  name = "relay_ssm_access"
  role = aws_iam_role.ec2_ssm_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "ssm:GetParameter",
          "ssm:GetParameters"
        ]
        Resource = [aws_ssm_parameter.ws_secret.arn]
      }
    ]
  })
}

resource "aws_iam_instance_profile" "ec2_profile" {
  name = "relay_ec2_profile"
  role = aws_iam_role.ec2_ssm_role.name
}

variable "admin_ssh_cidr" {
  description = "CIDR block allowed to SSH into manager"
  type        = string
}

variable "relay_username" {
  description = "Username for Relay login"
  type        = string
  default     = ""
}

variable "relay_password" {
  description = "Password for Relay login"
  type        = string
  sensitive   = true
  default     = ""
}

# Store WS Secret in SSM Parameter Store
resource "aws_ssm_parameter" "ws_secret" {
  name        = "/relay/ws_secret"
  description = "WebSocket authentication secret"
  type        = "SecureString"
  value       = var.ws_authentication_secret

  tags = {
    Environment = var.environment
  }
}

resource "aws_instance" "manager" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = "t3.small"
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.manager_sg.id]
  associate_public_ip_address = true
  key_name                    = var.ssh_key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2_profile.name

  user_data = templatefile("${path.module}/user_data_manager.sh", {
    # No longer passing secret directly
    ssm_parameter_name = aws_ssm_parameter.ws_secret.name
    region             = var.region
  })
  
  # Require IMDSv2 for enhanced security
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  tags = {
    Name        = "relay-manager"
    Environment = var.environment
    ManagedBy   = "terraform"
    Role        = "manager"
  }
}

resource "aws_instance" "worker" {
  count                       = var.worker_count
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = "t3.medium"
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.worker_sg.id]
  associate_public_ip_address = true
  key_name                    = var.ssh_key_name
  iam_instance_profile        = aws_iam_instance_profile.ec2_profile.name

  user_data = templatefile("${path.module}/user_data_worker.sh", {
    manager_private_ip = aws_instance.manager.private_ip
    # No longer passing secret directly
    ssm_parameter_name = aws_ssm_parameter.ws_secret.name
    region             = var.region
    node_id            = "worker-${count.index}"
    relay_username     = var.relay_username
    relay_password     = var.relay_password
  })
  
  # Require IMDSv2 for enhanced security
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
    instance_metadata_tags      = "enabled"
  }

  tags = {
    Name        = "relay-worker-${count.index}"
    Environment = var.environment
    ManagedBy   = "terraform"
    Role        = "worker"
  }
}

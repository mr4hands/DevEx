resource "aws_security_group" "instance" {
  name        = "${var.instance_name}-sg"
  description = "Allow SSH and HTTPS inbound for ${var.instance_name}."
  vpc_id      = var.vpc_id

  ingress {
    description = "SSH from allowed CIDRs."
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  ingress {
    description = "HTTPS from allowed CIDRs."
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.allowed_cidrs
  }

  egress {
    description = "Unrestricted outbound."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.instance_name}-sg"
  }
}

resource "aws_instance" "this" {
  # checkov:skip=CKV2_AWS_41: No IAM role needed for this lab/test instance.
  ami                    = var.ami_id
  instance_type          = var.instance_type
  subnet_id              = var.subnet_id
  vpc_security_group_ids = [aws_security_group.instance.id]
  monitoring             = true
  ebs_optimized          = true

  metadata_options {
    http_tokens = "required"
  }

  root_block_device {
    encrypted = true
  }

  tags = {
    Name = var.instance_name
  }
}

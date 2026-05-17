mock_provider "aws" {}

variables {
  instance_name = "tftest-ec2"
  ami_id        = "ami-12345678"
  vpc_id        = "vpc-00000000"
  subnet_id     = "subnet-00000000"
  allowed_cidrs = ["10.0.0.0/16"]
}

run "plan_with_minimum_inputs" {
  command = plan

  assert {
    condition     = output.instance_id != null && output.instance_id != ""
    error_message = "instance_id output must be non-empty."
  }

  assert {
    condition     = output.instance_private_ip != null
    error_message = "instance_private_ip output must exist."
  }

  assert {
    condition     = output.security_group_id != null && output.security_group_id != ""
    error_message = "security_group_id output must be non-empty."
  }
}

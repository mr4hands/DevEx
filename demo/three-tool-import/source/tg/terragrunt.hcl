terraform {
  source = "./module"
}

inputs = {
  # Populated by the apply-sources.sh helper from the TF source's output.
  vpc_id            = get_env("DEMO_VPC_ID")
  cidr_block        = "10.99.5.0/24"
  availability_zone = "us-east-1a"
}

resource "aws_vpc" "this" {
  cidr_block           = var.cidr_block
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = merge(local.name_tag, var.tags)
}

# AWS auto-creates a default SG on every VPC. Adopt it explicitly and
# strip every rule so it can't be used as a permissive fallback.
resource "aws_default_security_group" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-default-locked"
    },
  )
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id

  tags = merge(local.name_tag, var.tags)
}

resource "aws_subnet" "public" {
  # checkov:skip=CKV_AWS_130: Public subnets must assign public IPs by definition;
  # the whole point of this resource is the public-egress side of the VPC.
  for_each = var.public_subnets

  vpc_id                  = aws_vpc.this.id
  cidr_block              = each.value
  availability_zone       = each.key
  map_public_ip_on_launch = true

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-public-${each.key}"
      Tier = "public"
    },
  )
}

resource "aws_subnet" "private" {
  for_each = var.private_subnets

  vpc_id            = aws_vpc.this.id
  cidr_block        = each.value
  availability_zone = each.key

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-private-${each.key}"
      Tier = "private"
    },
  )
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-public"
      Tier = "public"
    },
  )
}

resource "aws_route_table_association" "public" {
  for_each = aws_subnet.public

  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}

resource "aws_eip" "nat" {
  for_each = toset(local.nat_gateway_keys)
  domain   = "vpc"

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-nat-${each.key}"
    },
  )
}

resource "aws_nat_gateway" "this" {
  for_each = toset(local.nat_gateway_keys)

  allocation_id = aws_eip.nat[each.key].id
  subnet_id     = aws_subnet.public[each.key].id

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-nat-${each.key}"
    },
  )

  depends_on = [aws_internet_gateway.this]
}

resource "aws_route_table" "private" {
  for_each = var.private_subnets

  vpc_id = aws_vpc.this.id

  dynamic "route" {
    for_each = var.enable_nat_gateway ? [1] : []

    content {
      cidr_block = "0.0.0.0/0"
      nat_gateway_id = (
        var.single_nat_gateway
        ? aws_nat_gateway.this[local.nat_gateway_keys[0]].id
        : aws_nat_gateway.this[each.key].id
      )
    }
  }

  tags = merge(
    var.tags,
    {
      Name = "${var.name}-private-${each.key}"
      Tier = "private"
    },
  )
}

resource "aws_route_table_association" "private" {
  for_each = aws_subnet.private

  subnet_id      = each.value.id
  route_table_id = aws_route_table.private[each.key].id
}

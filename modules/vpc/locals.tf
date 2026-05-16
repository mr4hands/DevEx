locals {
  name_tag = { Name = var.name }

  private_az_keys = sort(keys(var.private_subnets))

  nat_gateway_keys = (
    var.enable_nat_gateway && length(local.private_az_keys) > 0
    ? (var.single_nat_gateway ? [local.private_az_keys[0]] : local.private_az_keys)
    : []
  )
}

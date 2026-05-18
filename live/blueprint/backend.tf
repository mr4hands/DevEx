terraform {
  # Local backend for the blueprint workspace by default. This is a
  # rapid-iteration sandbox driven by the UI's Blueprint canvas; it
  # doesn't share state with `live/dev/` and isn't expected to be
  # multi-user. Promote to the S3 backend (see backend.local.hcl.example)
  # once the workspace's HCL stabilizes.
  backend "local" {}
}
